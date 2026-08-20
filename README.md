# Log Ingestion & Query Service

A backend service for ingesting, storing, querying, and aggregating structured logs using TypeScript, Fastify, and PostgreSQL.

The service was built to handle high-volume log ingestion and queries within the project's resource limits.

## Features

- **Batch ingestion** — `POST /logs` with per-entry validation and partial batch acceptance.
- **Filtered querying** — `GET /logs` with service, level, time range, message, and attribute filters.
- **Cursor pagination** — Stable pagination using `(ts, id)`.
- **Aggregation** — `GET /logs/aggregate` with `1m`, `5m`, `1h`, and `1d` buckets.
- **Retention** — Configurable retention with chunked deletes.
- **Optional authentication** — API-key authentication with `ingest` and `query` scopes.
- **Batched writes** — Incoming logs are grouped into larger PostgreSQL inserts for higher throughput.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 |
| Language | TypeScript |
| HTTP | Fastify 5 |
| Validation | Ajv |
| Database | PostgreSQL 16 |
| Deployment | Docker Compose |
| CI | GitHub Actions |

## Running the Project

The project starts with Docker Compose.

```bash
docker compose up -d
```
