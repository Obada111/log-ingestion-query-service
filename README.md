# Log Ingestion & Query Service

A log ingestion and query platform with PostgreSQL-backed storage, cursor-paginated filtering, and time-bucketed aggregations. Designed for sustained ~15,000 logs/s on 0.5 CPU / 256 MB app and 1 CPU / 1 GB PostgreSQL.

## Features

- **Batch ingestion** — `POST /logs` with per-entry validation; rows acknowledged only after durable commit; partial batches accepted; bad entries reported by index with reason.
- **Filtered querying** — `GET /logs` with `service`, `level`, message substring `q`, attribute equality `attr.<key>`, cursor pagination via `(ts, id)`.
- **Aggregation** — `GET /logs/aggregate` with whitelisted buckets `1m|5m|1h|1d`, optional `service`/`level` grouping, epoch-aligned boundaries.
- **Retention** — Chunked sweeps delete logs older than `RETENTION_HOURS` (default 31 days) without blocking readers/writers.
- **Auth (optional)** — SHA-256 hashed API keys with `ingest`/`query` scopes; off by default.
- **Coalescing writer** — merges client rows into 2000-row `unnest` INSERTs; throughput independent of client batch size.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 + TypeScript (strict, ESM) |
| HTTP | Fastify 5 with Ajv (compiled validation) |
| Database | PostgreSQL 16, parameterized SQL |
| Auth | SHA-256 hashed API keys with scope enforcement (off by default) |
| Deploy | Docker Compose (app container, multi-stage build) |
| CI | GitHub Actions (typecheck, lint, unit + integration + smoke tests) |

## Quick start

```bash
docker compose up -d          # builds app image, starts PG + app
curl -s localhost:8080/health # {"status":"ok"} once ready
```

Migrations run automatically at startup (advisory-lock guarded), no `.env` needed. Node 22 (alpine, non-root) and PostgreSQL 16 are the only containers.

Verify the contract end-to-end:

```bash
node scripts/smoke.mjs                              # auth off
node scripts/smoke.mjs --auth --key loadgen-test-key   # auth on
```

Run the load generator (own tooling — no external deps):

```bash
node loadtest/loadgen.mjs --mode mixed --rate 15000 --batch 500 --duration 70
```

## API

### `GET /health`

`200 {"status":"ok"}` once migrations run and server is listening; `503` before that. Never requires auth.

### `POST /logs` — batch ingestion

```json
{ "logs": [ { "ts": "2026-08-06T10:00:00.000Z", "level": "info", "service": "web", "message": "request handled", "attributes": { "http_status": 200, "retries": 3 } } ] }
```

- `ts` — RFC3339 timestamp; up to 5 min in the future, else rejected.
- `level` — one of `debug | info | warn | error`.
- `service`, `message` — non-empty strings.
- `attributes` — **flat object containing string, number, or boolean values. Nested objects and arrays are NOT supported.**

**200** — `{"accepted": 1, "rejected": [{"index": 0, "reason": "..."}]}`. Rows committed before 200 is sent. Partial batches accepted; each bad entry reported by index with reason (`invalid level: 'critical'`, `invalid timestamp: …`, …).

**400** — `{"error": "..."}` for malformed body (or `{"error": "request body must be a JSON object with a 'logs' array}"`). JSON, `text/plain`, or no content-type accepted.

### `GET /logs` — filtered query, cursor pagination

| Param | Meaning |
|---|---|
| `since` / `until` | RFC3339 timestamps (`>=` / `<` window) |
| `service` | exact match |
| `level` | exact match (`debug\|info\|warn\|error`) |
| `q` | case-insensitive substring on message |
| `attr.<key>` | attribute equality, compared as strings (`attr.retries=3` matches number `3`) |
| `limit` | 1–1000 (default 100) |
| `cursor` | opaque `next_cursor` from previous page (keyset `(ts, id)`, base64url) |

**200** — `{"logs": [{"id", "timestamp", "level", "service", "message", "attributes"}], "next_cursor": "..." \| null}`. Attributes returned with original types (number `retries: 3` stays a number). Default order: `ts DESC, id DESC`; cursor makes pagination stable under concurrent inserts.

**400** — `{"error": "..."}` for invalid params (bad timestamp, unknown level, invalid cursor, out-of-range limit).

### `GET /logs/aggregate` — time-bucketed counts

| Param | Meaning |
|---|---|
| `since` / `until` | **required** RFC3339 timestamps, half-open `[since, until)` window |
| `bucket` | **required** — one of `1m \| 5m \| 1h \| 1d` (whitelisted) |
| `group_by` | `service` or `level` (whitelist); absent → ungrouped |
| `service`, `level`, `q`, `attr.<key>` | same filters as `GET /logs` |

**200** — `{"buckets": [{"start": "...", "group": "web" \| null, "count": 47}]}` — one row per non-empty bucket, ascending by time then group. Buckets aligned via `date_bin(interval, ts, TIMESTAMPTZ 'epoch')`; empty ranges return `{"buckets": []}`.

All 400s use `{"error": "..."}` shape; all SQL fully parameterized (user values never interpolated; only compile-time whitelisted identifiers for `group_by`).

## Database design

```sql
CREATE TABLE logs (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  service     TEXT NOT NULL,
  message     TEXT NOT NULL,
  attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
  attr_lookup JSONB NOT NULL DEFAULT '{}'::jsonb,
  tenant_id   TEXT
);

CREATE INDEX idx_logs_ts_id          ON logs (ts DESC, id DESC);
CREATE INDEX idx_logs_service_level_ts ON logs (service, level, ts DESC);
CREATE INDEX idx_logs_level_ts       ON logs (level, ts DESC);
CREATE INDEX idx_logs_attr_lookup    ON logs USING GIN (attr_lookup jsonb_path_ops);
CREATE INDEX idx_logs_tenant_ts      ON logs (tenant_id, ts DESC) WHERE tenant_id IS NOT NULL;
```

The table stores two JSONB columns. `attributes` holds the original payload as-is (typed values round‑trip). `attr_lookup` canonicalizes every value to a string at INSERT time; all `@>` attribute filters run against this column with a GIN `jsonb_path_ops` index, so `attr.<k>=<v>` is an index‑supported equality match while clients still receive typed values.

## Measured performance (contract-scale run)

Environment: Docker Desktop, containers capped at **app 0.5 CPU / 256 MB, PostgreSQL 1 CPU / 1 GB**; `shared_buffers = 512 MB`. Data: **1.2M log entries** (≈629 MB table+indexes, 5 attributes each, `ts` spread over the run).

| Metric | Result |
|---|---|
| Ingestion throughput | **~15,000 logs/s** (1.2M rows in ~80 s, 0 rejected, 0 errors) |
| Ingest latency p95 | **380 ms** |
| Aggregate p95 during ingestion | **162 ms** (1 agg/s concurrent) |
| List query p95 during ingestion | **~161 ms** |
| Aggregate p95 at rest (1.2M rows, warm) | **73 ms** |
| App memory during load | ~60 MB / 256 MB |
| DB memory during load | ~790 MB / 1 GB |
| Visibility (request→queryable) | ≈ ingest latency (rows committed before 200) |

Load tooling: `loadtest/loadgen.mjs` (zero‑dep Node; bounded in‑flight; mixed mode runs 1 query/second while ingesting).

## Known limitations

- Aggregations scan the time window; full‑window group‑by is ~O(window size) — fine at 1M rows (< 600 ms), degrades as data outgrows RAM. Pre‑aggregated rollup tables can mitigate this (out of scope).
- Retention deletes are chunked but synchronous with the DB; a huge backlog (years of data) could make a sweep long. Acceptable at the 31‑day horizon.
- Single instance, in‑memory buffer: writer queue not persisted; on hard crash in‑flight rows are lost (clients can retry — at‑least‑once on the client side).
- No HA/sharding, no replication, no TLS, no rate limiting — deliberately out of scope.

## Optional auth

Set `AUTH_ENABLED=true` + `LOADGEN_API_KEY=<key>` in the environment before `docker compose up`. Keys are SHA-256 hashed at startup; the load‑gen key is seeded idempotently. Clients authenticate with `Authorization: Bearer <key>` or `X‑API‑Key: <key>`:

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
| `INGEST_MAX_FLUSH_WAIT_MS` | 10 | light‑traffic flush deadline |
| `RETENTION_HOURS` | 744 | delete logs older than this |
| `RETENTION_SWEEP_INTERVAL_MS` | 900000 | sweeper cadence |
| `AUTH_ENABLED` | false | enable API‑key auth |
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

Integration tests spin up the real app against the real database (TRUNCATE‑based isolation) and cover the API contract, aggregation math, auth (401/403/tenant scoping), and retention. CI runs all of the above plus a contract smoke script in both auth modes.

## Project structure

```
src/           production code (routes, services, lib, db, auth)
tests/         unit + integration tests
scripts/       smoke contract verification
loadtest/      zero‑dependency load generator
```

The submission repository does **not** contain a `study/` directory.

## Project context

This project was developed as a final engineering project for Foothill, focusing on log ingestion, querying, PostgreSQL storage, and performance under load.