import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTestApp, drainWriter, makeLog, type TestApp } from "./helpers.js";

let t: TestApp;

before(async () => {
  t = await setupTestApp();
});
after(async () => {
  await t?.close();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return t.app.inject({
    method: "POST",
    url: "/logs",
    payload: body as object,
    headers,
  });
}

describe("POST /logs", () => {
  it("accepts a batch and reports per-entry rejections", async () => {
    const res = await post({
      logs: [
        makeLog(),
        makeLog({ level: "critical", message: "x" }),
        makeLog({ timestamp: "garbage" }),
        makeLog({ service: "" }),
        makeLog({ message: "" }),
        makeLog({ attributes: { nested: { a: 1 } } }),
        makeLog({ attributes: [1, 2] }),
        makeLog({ attributes: { v: null } }),
        makeLog({ timestamp: new Date(Date.now() + 10 * 60_000).toISOString() }),
        makeLog({ attributes: { user_id: "42", retries: 3, ok: true } }),
      ],
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.accepted, 2);
    assert.equal(body.rejected.length, 8);
    assert.deepEqual(body.rejected.map((r: { index: number }) => r.index), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(body.rejected.every((r: { index: number; reason: string }) => typeof r.reason === "string"));
  });

  it("rejects malformed JSON with 400 and an error body", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/logs",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(typeof res.json().error, "string");
  });

  it("rejects wrong top-level structures with 400", async () => {
    for (const payload of [{}, { logs: "nope" }, { logs: 42 }, [], "hello", null]) {
      const res = await post(payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(typeof res.json().error, "string");
    }
  });

  it("returns 400 with accepted:0 when the whole batch is rejected", async () => {
    const res = await post({ logs: [makeLog({ level: "critical" })] });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { accepted: 0, rejected: [{ index: 0, reason: "invalid level: 'critical'" }] });
  });

  it("returns 400 with accepted:0 for an empty logs array", async () => {
    const res = await post({ logs: [] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().accepted, 0);
  });

  it("accepts a single-entry batch", async () => {
    const res = await post({ logs: [makeLog()] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, 1);
  });

  it("accepts text/plain bodies with JSON content", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/logs",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({ logs: [makeLog()] }),
    });
    assert.equal(res.statusCode, 200);
  });
});

describe("GET /logs", () => {
  before(async () => {
    // Isolate this suite's dataset: the POST /logs tests above already
    // inserted rows (which is exactly what we want to test) but this suite
    // needs a known population.
    await t.pool.query("TRUNCATE logs, log_counts RESTART IDENTITY");
    // Deterministic dataset: 5 distinct services x 2 levels, known timestamps.
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 5; i++) {
      for (const level of ["debug", "info", "warn", "error"]) {
        rows.push(
          makeLog({
            timestamp: new Date(Date.UTC(2026, 6, 20, 14, 0, 0) + i * 60_000).toISOString(),
            service: `svc-${i}`,
            level,
            message: `message ${i} for level ${level}`,
            attributes: { user_id: `user-${i}`, region: i % 2 === 0 ? "eu-west" : "us-east", retries: i },
          })
        );
      }
    }
    rows.push(makeLog({ timestamp: "2026-07-20T14:00:00.000Z", service: "svc-0", message: "50% done" }));
    await post({ logs: rows });
    await drainWriter(t.writer);
  });

  it("returns an empty page for an empty table", async () => {
    const res = await t.app.inject({ method: "GET", url: "/logs?service=does-not-exist" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { logs: [], next_cursor: null });
  });

  it("filters by service, level and time range", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/logs?service=svc-1&level=error&since=2026-07-20T14:00:00Z&until=2026-07-20T14:05:00Z",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0].service, "svc-1");
    assert.equal(body.logs[0].level, "error");
  });

  it("uses until exclusively and since inclusively", async () => {
    const boundary = new Date(Date.UTC(2026, 6, 20, 14, 1, 0)).toISOString();
    const inside = await t.app.inject({ method: "GET", url: `/logs?since=${encodeURIComponent(boundary)}` });
    assert.equal(inside.json().logs.length, 16); // timestamps 14:01..14:04, 4 levels each
    const outside = await t.app.inject({
      method: "GET",
      url: `/logs?until=${encodeURIComponent(boundary)}`,
    });
    assert.equal(outside.json().logs.length, 5); // 14:00:00 rows (4 levels + the extra "50%" row)
  });

  it("matches attributes by string comparison regardless of stored type", async () => {
    // retries is stored as a NUMBER (i) in the original attributes; the
    // contract compares attributes as strings, so the string query must match.
    const res = await t.app.inject({ method: "GET", url: "/logs?service=svc-2&attr.retries=2" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().logs.length, 4); // all 4 levels of svc-2
    const negative = await t.app.inject({ method: "GET", url: "/logs?service=svc-2&attr.retries=99" });
    assert.equal(negative.json().logs.length, 0);
    const res2 = await t.app.inject({ method: "GET", url: "/logs?attr.user_id=user-2" });
    assert.equal(res2.json().logs.length, 4);
  });

  it("combines attribute filters", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/logs?service=svc-0&attr.region=eu-west&attr.user_id=user-0&level=error",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().logs.length, 1);
  });

  it("searches messages case-insensitively", async () => {
    const res = await t.app.inject({ method: "GET", url: "/logs?q=FOR%20LEVEL" });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().logs.length > 0);
  });

  it("treats LIKE wildcards in q as literals", async () => {
    const res = await t.app.inject({ method: "GET", url: "/logs?q=%25" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().logs.length, 1);
    assert.match(res.json().logs[0].message, /50% done/);
  });

  it("sorts by timestamp desc and breaks ties deterministically by id", async () => {
    // 5 rows share 14:00:00.000Z (one per service + the "50%" one).
    const res = await t.app.inject({ method: "GET", url: "/logs?since=2026-07-20T14:00:00.000Z&until=2026-07-20T14:00:01.000Z" });
    const logs = res.json().logs;
    assert.equal(logs.length, 5);
    const ids = logs.map((l: { id: string }) => l.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => Number(b) - Number(a)));
  });

  it("walks the entire table via cursors without duplicates or gaps", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/logs?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await t.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.logs.length <= 7);
      for (const log of body.logs) seen.push(log.id);
      cursor = body.next_cursor;
      pages++;
    } while (cursor !== null);
    assert.ok(pages >= 3, `expected multiple pages, got ${pages}`);
    assert.equal(seen.length, 21);
    assert.equal(new Set(seen).size, 21, "no duplicates across pages");
  });

  it("returns the last page with next_cursor null", async () => {
    const res = await t.app.inject({ method: "GET", url: "/logs?limit=1000" });
    assert.equal(res.json().logs.length, 21);
    assert.equal(res.json().next_cursor, null);
  });

  it("rejects invalid parameters with 400 {error}", async () => {
    const cases = [
      "/logs?level=fatal",
      "/logs?since=nonsense",
      "/logs?until=2020-01-01T00:00:00Z&since=2021-01-01T00:00:00Z",
      "/logs?limit=abc",
      "/logs?limit=0",
      "/logs?limit=2000",
      "/logs?cursor=!!!",
      "/logs?service=",
    ];
    for (const url of cases) {
      const res = await t.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      assert.equal(typeof res.json().error, "string", url);
    }
  });
});
