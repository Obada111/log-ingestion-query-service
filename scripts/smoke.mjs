#!/usr/bin/env node
/**
 * Required-contract smoke test. Runs against a live stack (docker compose up).
 * Exits non-zero on any contract violation.
 *
 * Usage:
 *   node scripts/smoke.mjs [--auth] [--key <KEY>]
 *
 * Without --auth it verifies the four endpoints need no credentials.
 * With --auth it verifies Bearer auth: no token -> 401, bad token -> 401,
 * good token -> 200 on all data endpoints, /health always open.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
// Unique per run: the DB volume persists between smoke runs and the query
// below asserts exact counts, so every run must write to its own namespace.
const SERVICE = `smoke-${Date.now()}`;

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  âœ” ${msg}`);
  else {
    failures++;
    console.error(`  âœ– ${msg}`);
  }
};

async function call(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

async function main() {
  const auth = process.argv.includes("--auth");
  const keyIdx = process.argv.indexOf("--key");
  const key = keyIdx >= 0 ? process.argv[keyIdx + 1] : "smoke-test-key";
  const headers = auth ? { authorization: `Bearer ${key}` } : {};

  console.log(auth ? "== AUTH_ENABLED=true ==" : "== AUTH_ENABLED=false ==");

  // 1. Health is always open, returns 200 only when ready.
  const health = await call("/health");
  ok(health.status === 200, "GET /health -> 200");

  // 2. Ingest a mixed batch: valid entries accepted, invalid ones rejected.
  const batch = {
    logs: [
      {
        timestamp: new Date().toISOString(),
        level: "error",
        service: SERVICE,
        message: "payment declined",
        attributes: { user_id: "42", retries: 3, region: "eu-west" },
      },
      {
        timestamp: new Date().toISOString(),
        level: "info",
        service: SERVICE,
        message: "checkout ok",
      },
      { timestamp: new Date().toISOString(), level: "critical", service: SERVICE, message: "bad" },
    ],
  };
  const ingest = await call("/logs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(batch),
  });
  ok(ingest.status === 200, "POST /logs -> 200 with partial rejections");
  ok(ingest.body?.accepted === 2, "accepted == 2");
  ok(Array.isArray(ingest.body?.rejected) && ingest.body.rejected.length === 1, "one rejection");
  ok(ingest.body.rejected[0]?.index === 2, "rejection index == 2");

  // 3. Query with combined filters.
  const since = new Date(Date.now() - 60_000).toISOString();
  const until = new Date(Date.now() + 60_000).toISOString();
  const list = await call(
    `/logs?service=${SERVICE}&level=error&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&attr.user_id=42&q=declined&limit=10`,
    { headers }
  );
  ok(list.status === 200, "GET /logs -> 200 with combined filters");
  ok(list.body?.logs?.length === 1, "exactly one matching log");
  ok(list.body.logs[0].attributes.user_id === "42", "attributes preserved (typed value)");
  ok("next_cursor" in list.body, "next_cursor present");

  // 4. Aggregate.
  const agg = await call(
    `/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m&group_by=service&service=${SERVICE}`,
    { headers }
  );
  ok(agg.status === 200, "GET /logs/aggregate -> 200");
  ok(agg.body?.buckets?.length >= 1, "at least one bucket");
  ok(agg.body.buckets[0].count === 2 && agg.body.buckets[0].group === SERVICE, "bucket counts correct");

  // 5. Invalid query params -> 400 {"error"}.
  const bad = await call("/logs?level=fatal", { headers });
  ok(bad.status === 400 && typeof bad.body?.error === "string", "invalid level -> 400 {error}");

  if (auth) {
    // 6. Without credentials -> 401, never 500/200.
    for (const [method, path] of [
      ["POST", "/logs"],
      ["GET", "/logs"],
      ["GET", "/logs/aggregate?since=2026-01-01T00:00:00Z&until=2026-01-02T00:00:00Z&bucket=1m"],
    ]) {
      const r = await call(path, { method, headers: { "content-type": "application/json" } });
      ok(r.status === 401, `${method} ${path} -> 401 without credentials`);
    }
    // 7. Wrong token -> 401.
    const wrong = await call("/logs", { headers: { authorization: "Bearer wrong-key" } });
    ok(wrong.status === 401, "wrong key -> 401");
  } else {
    // 7. Credentials present but auth off -> ignored, request succeeds.
    const withCreds = await call("/logs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ignored-key" },
      body: JSON.stringify({ logs: [{ timestamp: new Date().toISOString(), level: "info", service: SERVICE, message: "x" }] }),
    });
    ok(withCreds.status === 200, "credentials ignored when auth disabled");
  }

  console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures})`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("smoke failed with exception:", err);
  process.exit(1);
});


