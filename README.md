# Log Ingestion & Query Service

A Datadog/Loki-style log ingestion and query platform built with **Fastify, TypeScript, and PostgreSQL**, runnable with a single `docker compose up`. Designed to sustain **15,000 logs/s ingestion on 0.5 CPU / 256 MB** while serving filtered queries and time-bucketed aggregations against **1M+ rows** from a **1 CPU / 1 GB** PostgreSQL 16 container.

## Features

- **High-throughput batch ingestion** — `POST /logs` with per-entry validation and per-index rejection reasons; rows are acknowledged only after durable commit
- **Coalescing write pipeline** — concurrent requests merge into large 2000-row `unnest` INSERTs, making throughput independent of client batch size
- **Filtered querying** — `service`, `level`, message substring, time range, and typed attribute equality filters with stable keyset (cursor) pagination
- **Time-bucketed aggregation** — `1m / 5m / 1h / 1d` buckets, epoch-aligned, with optional `service` / `level` grouping
- **Double-JSONB attribute strategy** — attributes round-trip with original types while attribute filters match values as strings, backed by a GIN index
- **Chunked retention sweeps** — bounded, yielding deletes that never block writers or readers
- **Optional API-key auth + multi-tenancy** — hashed keys, scope enforcement, tenant-scoped reads/writes (off by default)
- **Zero external tooling** — migrations auto-run at startup; the load generator is dependency-free Node

## Architecture

```
HTTP clients ──▶ Fastify app (0.5 CPU / 256 MB)
                     │  POST /logs (batch, per-entry validation)
                     ▼
              Coalescing IngestWriter
              (shared buffer → big 2000-row INSERTs)
                     ▼
              PostgreSQL 16 (1 CPU / 1 GB)
              logs table + 5 indexes (double-JSONB attribute strategy)
```

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 + TypeScript (strict, ESM) |
| HTTP | Fastify 5 with Ajv (compiled validation) |
| Database | PostgreSQL 16, fully parameterized SQL |
| Auth | SHA-256 hashed API keys with scope enforcement |
| Deploy | Docker Compose (non-root app container, multi-stage build) |
| CI | GitHub Actions (typecheck, lint, unit + integration + smoke tests) |

## Quick start

```bash
docker compose up -d          # builds the app image, starts PG + app
curl -s localhost:8080/health # {"status":"ok"} once ready
```

That's the whole setup: migrations run automatically at startup (advisory-lock guarded), no `.env` file needed. Node 22 (alpine, non-root) and PostgreSQL 16 are the only containers.

Verify the contract end-to-end:

```bash
node scripts/smoke.mjs                              # auth off
node scripts/smoke.mjs --auth --key loadgen-test-key   # auth on (see below)
```

Run the load generator (own tooling — no external deps):

```bash
node loadtest/loadgen.mjs --mode mixed --rate 15000 --batch 500 --duration 70
# ingestion + 1 aggregate/list query per second, JSON summary with percentiles
```

## API

### `GET /health`

`200 {"status":"ok"}` once migrations have run and the server is listening; `503` before that. Never requires auth.

### `POST /logs` — batch ingestion

```json
{ "logs": [
  { "ts": "2026-08-06T10:00:00.000Z", "level": "info", "service": "web",
    "message": "request handled", "attributes": { "http_status": 200, "retries": 3, "method": "GET" } }
] }
```

- `ts` — RFC3339 timestamp; up to 5 minutes in the future, else rejected (`MAX_FUTURE_SKEW_MS`).
- `level` — one of `debug | info | warn | error`.
- `service`, `message` — non-empty strings.
- `attributes` — optional object with string/number/boolean values (nested values are serialized as JSON).

**200** — `{"accepted": 1, "rejected": [{"index": 0, "reason": "..."}]}`. Rows are answered only after they are durably committed by PostgreSQL (200 never means "queued"). Partial batches are accepted; each bad entry is reported by index with a reason (`invalid level: 'critical'`, `invalid timestamp: ...`, …).
**400** — `{"accepted": 0, "rejected": [...]}` when every entry failed, or `{"error": "request body must be a JSON object with a 'logs' array"}` for a malformed body. Either JSON or `text/plain` content types are accepted (no content-type also works).

### `GET /logs` — filtered query, cursor pagination

| Param | Meaning |
|---|---|
| `since` / `until` | RFC3339 timestamps (lexical `>=` / `<` window) |
| `service` | exact match |
| `level` | exact match (`debug\|info\|warn\|error`) |
| `q` | case-insensitive substring match on message |
| `attr.<key>` | attribute equality, **compared as strings** (`attr.http_status=200` matches `200` as a number too) |
| `limit` | 1–1000 (default 100) |
| `cursor` | opaque `next_cursor` from a previous page (keyset `(ts, id)`, base64url) |

**200** — `{"logs": [{"id", "timestamp", "level", "service", "message", "attributes"}], "next_cursor": "..." \| null}`. Attributes are returned with their **original types** (number `retries: 3` stays a number). Default order: `ts DESC, id DESC`; the cursor makes pagination stable under concurrent inserts (no offset-based duplicates/misses).
**400** — `{"error": "..."}` for invalid params (bad timestamp, unknown level, invalid cursor, out-of-range limit).

### `GET /logs/aggregate` — time-bucketed counts

| Param | Meaning |
|---|---|
| `since` / `until` | RFC3339 timestamps — **required**, half-open `[since, until)` window |
| `bucket` | **required** — one of `1m \| 5m \| 1h \| 1d` (whitelisted) |
| `group_by` | `service` or `level` (whitelist); absent → ungrouped |
| `level`, `service`, `q`, `attr.<key>` | same filters as GET /logs |

**200** — `{"buckets": [{"start": "...", "group": "web" \| null, "count": 47}]}` — one row per non-empty bucket, ascending by time then group. Buckets are aligned to the epoch via `date_bin(interval, ts, TIMESTAMPTZ 'epoch')` (timezone-independent boundaries), `count` is `int`, empty ranges return `{"buckets": []}`.

All 400s use the `{"error": "..."}` shape; all SQL is fully parameterized (user values never interpolated; only compile-time whitelisted identifiers for `group_by`).

## Database design

```sql
CREATE TABLE logs (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  service     TEXT NOT NULL,
  message     TEXT NOT NULL,
  attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- original, typed
  attr_lookup JSONB NOT NULL DEFAULT '{}'::jsonb,  -- canonicalized, string-valued
  tenant_id   TEXT
);

CREATE INDEX idx_logs_ts_id          ON logs (ts DESC, id DESC);          -- default sort + keyset cursor
CREATE INDEX idx_logs_service_level_ts ON logs (service, level, ts DESC); -- common filter combo
CREATE INDEX idx_logs_level_ts       ON logs (level, ts DESC);            -- aggregate group_by=level
CREATE INDEX idx_logs_attr_lookup    ON logs USING GIN (attr_lookup jsonb_path_ops);
CREATE INDEX idx_logs_tenant_ts      ON logs (tenant_id, ts DESC) WHERE tenant_id IS NOT NULL;
```

### The double-JSONB attribute strategy

The contract requires `attributes` to round-trip with their original types (`retries: 3` stays a number), *and* attribute filters to match values **as strings** (`attr.retries=3` matches). Those two demands conflict with a single JSONB column: a plain `@>` match on the typed column would make `attr.retries="3"` (string) fail to match `3` (number).

So the table stores **two** JSONB columns:

- `attributes` — the original payload, returned verbatim to clients (typed).
- `attr_lookup` — the same object with every value canonicalized to a string, built at INSERT time in SQL (`jsonb_each` → `#>> '{}'` for scalars, `::text` for nested values). All attribute filters run `@>` against this column, backed by a GIN `jsonb_path_ops` index — so `attr.<k>=<v>` is an index-supported equality match while the client still receives typed values.

`attr.<k>` values are compared exactly as the query string (`escapeLike` is only used for `q`/message, which is a genuine substring match).

## Ingestion pipeline (why it sustains 15k/s on 0.5 CPU)

1. **Per-entry validation in the app** (Ajv) so every bad entry is reported by index in the same response.
2. **Coalescing writer** — handlers push validated rows into a shared in-memory buffer; a single writer drains it into `INSERT ... SELECT * FROM unnest($1::timestamptz[], ...)` statements. The flush trigger is **size-first**: a full target chunk (2000 rows) flushes immediately; the wait timer (10 ms) only fires for light traffic. This decouples throughput from the client's batch size.
3. **Measured cost profile**: a 500-row INSERT ≈ 72 ms, a 2000-row INSERT ≈ 80 ms — index maintenance dominates, so 4× the rows costs ~nothing extra.
4. **Dedicated write pool** (2 connections): read queries can never starve ingestion — a slow aggregate can occupy the read pool without stalling an INSERT.
5. **Server-side attribute canonicalization**: the app pays one `JSON.stringify` per row; the string-copy column is derived in SQL, keeping the CPU-capped app lean.

Retries: one automatic retry per chunk on transient failures; a failed chunk rejects every request in it (never a silent 200). The handler only resolves after PostgreSQL acknowledges the commit, so durability semantics are identical to per-request INSERTs — but throughput is ~5× higher at the same durability level.

## Retention

Logs older than `RETENTION_HOURS` (default 744 = 31 days) are deleted in **bounded chunks** (`DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT n)`) with a pause between chunks, so a sweep never holds a giant snapshot or starves the writer. The sweeper runs on `RETENTION_SWEEP_INTERVAL_MS` (default 15 min) and is reentrancy-guarded (overlapping runs are ignored).

## Measured performance (contract-scale run)

Environment: Docker Desktop (Windows host), containers capped at **app 0.5 CPU / 256 MB, PostgreSQL 1 CPU / 1 GB**; `shared_buffers = 512 MB`. Data: **1.2M log entries** (≈629 MB table+indexes, 5 attributes each, `ts` spread over the run).

| Metric | Result | Target |
|---|---|---|
| Ingestion throughput | **15,000 logs/s** (1.2M rows in 80 s, 0 rejected, 0 errors) | ≥ 15k/s |
| Ingest latency | p50 65 ms / p95 380 ms / p99 668 ms | — |
| Aggregate p95 during 15k/s ingestion | **162 ms** (1 agg/s concurrent) | < 1 s |
| List query p95 during ingestion | ~161 ms | — |
| Aggregate at rest (1.2M rows, warm) | p50 42 ms / p95 73 ms | < 1 s |
| Aggregate cold, full-window EXPLAIN | 575 ms (Index Only Scan, 1.2M rows) | < 1 s |
| App memory | ~60 MB / 256 MB during load | 256 MB |
| DB memory | ~790 MB / 1 GB during load | 1 GB |
| Visibility (request→queryable) | ≈ ingest latency (rows are committed before the 200) | < 20 s |

Load tooling: `loadtest/loadgen.mjs` (zero-dep Node fetch; bounded in-flight; pacing computed from elapsed time; mixed mode runs a query each second while ingesting).

### Bottlenecks found and how they were fixed

1. **Unbounded client concurrency collapse** — the first generator fired requests without an in-flight cap; hundreds of concurrent 200 KB bodies + buffered rows pinned the app at its 256 MB cap, GC stalled the event loop, latency spiraled to 13 s. Fix: bounded in-flight (50) in the generator; app memory stayed ~60 MB.
2. **Tiny INSERTs** — a 10 ms timer flushed whatever was pending, so ~500-row statements (≈72 ms each) capped the serial writer at ~7k/s. Fix: size-first flush (2000-row chunks, ≈80 ms each → 25k/s serial ceiling); measured 5.1k → 15k/s.
3. **Read/write pool contention** — slow aggregates held all 10 pool clients; the writer's acquire timed out at 5 s → failed chunks. Fix: dedicated 2-connection write pool (ingestion latency is now independent of query load).
4. **App CPU saturation at 0.5 CPU** — after the above, the app (parse + Ajv×500 + 2× stringify + pg encode per request) was the ceiling at ~98% of target. Fix: moved attribute canonicalization into the INSERT (PG had idle CPU); achieved exactly 15,000/s.
5. **Index cache misses** — at 256 MB `shared_buffers` the 629 MB working set read index pages from disk on every insert. Fix: `shared_buffers` 256 → 512 MB (DB has 1 GB).

## Known limitations

- **Aggregations scan the time window** (index-only scan at this scale). A full-window group-by is ~O(window size) — fine at 1M rows (< 600 ms), degrades super-linearly as data outgrows RAM. The escape hatch is a pre-aggregated rollup table maintained by the writer (out of scope here).
- **Retention deletes are chunked but synchronous with the DB**; a huge backlog (years of data) could make a sweep long. Acceptable at the contract's 31-day horizon.
- **Single instance, in-memory buffer**: the writer's queue is not persisted; on a hard crash in-flight rows are lost (the 200 has not been sent, so clients can retry — "at-least-once" semantics on the client side).
- **No HA/sharding, no replication, no TLS, no rate limiting** — deliberately out of scope.

## Future improvements

- Pre-aggregated rollup tables for constant-time full-window aggregates
- Time-based table partitioning + `DROP PARTITION` for O(1) retention
- Horizontal scaling: multiple app instances behind a queue (e.g. NATS/Kafka) with the writer as the sole consumer
- Prometheus metrics endpoint and structured request tracing

## Optional features

### Auth (default OFF)

Set `AUTH_ENABLED=true` + `LOADGEN_API_KEY=<key>` in the environment (or `.env`) before `docker compose up`. Keys are stored as SHA-256 hashes in `api_keys` (plaintext never hits the disk); the loadgen key is seeded idempotently at startup, before `/health` reports ready. Clients authenticate with `Authorization: Bearer <key>` or `X-API-Key: <key>`:

- `ingest` scope → `POST /logs`
- `query` scope → `GET /logs` + `GET /logs/aggregate`
- wrong/missing key → 401 `{"error":"unauthorized"}`; right key, wrong scope → 403 `{"error":"forbidden"}`
- with auth disabled, credentials are ignored (contract behavior)

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8080 | HTTP port |
| `DATABASE_URL` | `postgres://loguser:logpass@localhost:5432/logdb` | connection string |
| `PG_POOL_MAX` | 10 | read pool size |
| `PG_WRITE_POOL_MAX` | 2 | dedicated ingestion writer pool |
| `INGEST_MAX_ROWS_PER_FLUSH` | 2000 | coalescing chunk target |
| `INGEST_MAX_FLUSH_WAIT_MS` | 10 | light-traffic flush deadline |
| `RETENTION_HOURS` | 744 | delete logs older than this |
| `RETENTION_SWEEP_INTERVAL_MS` | 900000 | sweeper cadence |
| `AUTH_ENABLED` | false | enable API-key auth |
| `LOADGEN_API_KEY` | — | key seeded at startup (hashed) |
| `LOG_LEVEL` | info | pino log level |

## Testing

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run test             # 35 unit tests (validation, cursor, query params) — no DB needed
npm run test:integration # 39 tests — needs `docker compose up -d` (uses localhost:5432)
```

Integration tests spin up the real app against the real database (TRUNCATE-based isolation) and cover the API contract, aggregation math, auth (401/403/tenant scoping), and retention. CI runs all of the above plus a contract smoke script in both auth modes (`.github/workflows/ci.yml`).

## Project structure

```
src/           production code (routes, services, lib, db, auth)
tests/         unit + integration tests
scripts/       smoke contract verification
loadtest/      zero-dependency load generator
study/         design notes, experiments, and decision write-ups
```

## Project Context

This project was developed as a final engineering project for Foothill, focusing on designing and implementing a scalable log ingestion and query platform. The project emphasizes backend architecture, PostgreSQL optimization, API design, reliability, and performance engineering.
