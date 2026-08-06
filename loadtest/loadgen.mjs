#!/usr/bin/env node
/**
 * Load generator for the log service. Zero dependencies (Node 22 fetch).
 *
 * Phases:
 *   ramp-up (default 10s) -> steady (default 60s) at RATE logs/s
 *   optionally interleaves query load (GET /logs + GET /logs/aggregate)
 *
 * Modes (--mode):
 *   ingest-only  (default)  steady ingestion, then a query burst at the end
 *   mixed        query load runs every second DURING ingestion
 *   query-only   no ingestion; query load only (run against preloaded data)
 *
 * Output: one-line JSON summary plus percentiles.
 *
 * Example:
 *   node loadtest/loadgen.mjs --mode mixed --rate 15000 --batch 500 --duration 60
 */

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : process.env[name] ?? fallback;
};

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const RATE = Number(get("rate", 15000)); // target logs/second
const BATCH_SIZE = Number(get("batch", 500)); // logs per POST
const DURATION_S = Number(get("duration", 60));
const RAMP_S = Number(get("ramp", 10));
const MODE = get("mode", "ingest-only");
const QUERY_EVERY_S = Number(get("query-every", 1));
const QUERIES_PER_TICK = Number(get("queries-per-tick", 4));
const API_KEY = process.env.LOADGEN_API_KEY ?? "";

const SERVICES = ["checkout", "auth", "payments", "cart", "search", "inventory", "orders", "users"];
const LEVELS = ["debug", "info", "info", "info", "warn", "error"];
const REGIONS = ["eu-west", "eu-central", "us-east", "us-west", "ap-south", "ap-northeast"];
const MESSAGES = [
  "payment declined", "checkout completed", "user logged in", "cart updated",
  "search query executed", "inventory low", "order shipped", "rate limit hit",
  "cache miss", "retry scheduled", "webhook delivered", "session expired",
  "request timed out", "queue depth high", "feature flag evaluated", "index refreshed",
];

let seq = 0;
function makeLogs(n) {
  const logs = new Array(n);
  for (let i = 0; i < n; i++) {
    const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
    const user = String(1 + Math.floor(Math.random() * 1_000_000));
    logs[i] = {
      timestamp: new Date(Date.now() - Math.random() * 30_000).toISOString(),
      level: LEVELS[Math.floor(Math.random() * LEVELS.length)],
      service,
      message: `${MESSAGES[Math.floor(Math.random() * MESSAGES.length)]} (${++seq})`,
      attributes: {
        user_id: user,
        request_id: `${service}-${seq}`,
        region: REGIONS[Math.floor(Math.random() * REGIONS.length)],
        retries: Math.floor(Math.random() * 4),
        total_ms: Math.floor(Math.random() * 5000),
      },
    };
  }
  return logs;
}

const headers = { "content-type": "application/json" };
if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;

const stats = { sent: 0, accepted: 0, rejected: 0, errors: 0, statuses: {} };
const ingestLat = [];
const queryLat = [];

async function postBatch() {
  const payload = JSON.stringify({ logs: makeLogs(BATCH_SIZE) });
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/logs`, {
      method: "POST",
      headers,
      body: payload,
    });
    ingestLat.push(performance.now() - t0);
    stats.statuses[res.status] = (stats.statuses[res.status] ?? 0) + 1;
    const body = await res.json();
    stats.sent += BATCH_SIZE;
    stats.accepted += body.accepted ?? 0;
    stats.rejected += (body.rejected ?? []).length;
    if (res.status !== 200) stats.errors += body.rejected ? 0 : 1;
  } catch {
    stats.errors += BATCH_SIZE;
    stats.statuses["network-error"] = (stats.statuses["network-error"] ?? 0) + 1;
  }
}

async function runQuery(kind) {
  const t0 = performance.now();
  try {
    if (kind === "agg") {
      const until = Date.now();
      const since = until - 3600_000;
      const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
      const url = `${BASE}/logs/aggregate?since=${new Date(since).toISOString()}&until=${new Date(until).toISOString()}&bucket=5m&group_by=service&service=${service}`;
      const res = await fetch(url, { headers });
      await res.arrayBuffer();
      queryLat.push(performance.now() - t0);
    } else {
      const url = `${BASE}/logs?service=${SERVICES[Math.floor(Math.random() * SERVICES.length)]}&level=${LEVELS[Math.floor(Math.random() * LEVELS.length)]}&limit=100`;
      const res = await fetch(url, { headers });
      await res.arrayBuffer();
      queryLat.push(performance.now() - t0);
    }
  } catch {
    queryLat.push(performance.now() - t0);
  }
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summary(label) {
  // The pacing window is RAMP_S + DURATION_S; wall time after it includes the
  // settle wait, which would understate the sustained rate.
  const windowSec = RAMP_S + DURATION_S;
  const duration = (Date.now() - globalThis.__t0) / 1000;
  const rate = stats.accepted / (label === "ingest" ? windowSec : duration);
  const row = {
    label,
    mode: MODE,
    batch_size: BATCH_SIZE,
    duration_s: +duration.toFixed(1),
    target_rate: RATE,
    achieved_rate: +rate.toFixed(0),
    sent: stats.sent,
    accepted: stats.accepted,
    rejected: stats.rejected,
    errors: stats.errors,
    statuses: stats.statuses,
    ingest_latency_ms: { p50: +pct(ingestLat, 50).toFixed(1), p95: +pct(ingestLat, 95).toFixed(1), p99: +pct(ingestLat, 99).toFixed(1) },
    query_latency_ms: { n: queryLat.length, p50: +pct(queryLat, 50).toFixed(1), p95: +pct(queryLat, 95).toFixed(1), p99: +pct(queryLat, 99).toFixed(1) },
  };
  console.log(JSON.stringify(row));
  return row;
}

async function main() {
  globalThis.__t0 = Date.now();
  const totalBatches = Math.ceil((RATE * (DURATION_S + RAMP_S)) / BATCH_SIZE);
  const MAX_IN_FLIGHT = Number(get("concurrency", 50));

  // Batches-per-tick pacing: target cumulative batches vs elapsed time.
  let sentBatches = 0;
  let inFlight = 0;
  const perTickTarget = () => Math.ceil(((Date.now() - globalThis.__t0) / 1000) * (RATE / BATCH_SIZE));

  const send = async () => {
    inFlight++;
    try {
      await postBatch();
    } finally {
      inFlight--;
    }
  };

  let nextQueryAt = Date.now();

  const tick = async () => {
    const target = Math.min(perTickTarget(), totalBatches);
    while (sentBatches < target && inFlight < MAX_IN_FLIGHT) {
      sentBatches++;
      void send().catch(() => {});
    }
    if (MODE !== "query-only" && sentBatches >= totalBatches) return; // ingest phase done
    if (MODE === "mixed" && Date.now() >= nextQueryAt) {
      nextQueryAt = Date.now() + QUERY_EVERY_S * 1000;
      for (let i = 0; i < QUERIES_PER_TICK; i++) {
        void runQuery(Math.random() < 0.5 ? "agg" : "list").catch(() => {});
      }
    }
  };

  const interval = setInterval(() => void tick(), 50);

  if (MODE === "query-only") {
    clearInterval(interval);
    for (let i = 0; i < 60; i++) {
      await runQuery(Math.random() < 0.5 ? "agg" : "list");
    }
    summary("query-only");
    return;
  }

  const totalMs = (RAMP_S + DURATION_S) * 1000;
  const ingestDoneAt = Date.now() + totalMs;
  while (Date.now() < ingestDoneAt) {
    await new Promise((r) => setTimeout(r, 200));
  }
  clearInterval(interval);

  // Wait for in-flight requests to settle.
  while (inFlight > 0) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 2000));

  summary("ingest");

  if (MODE !== "mixed") {
    // Query burst against the loaded dataset.
    for (let i = 0; i < 30; i++) {
      await runQuery(Math.random() < 0.5 ? "agg" : "list");
    }
    summary("query-burst");
  }
}

main().catch((err) => {
  console.error("loadgen failed:", err);
  process.exit(1);
});
