# Study Course — Log Ingestion & Query Service

A complete learning course for the Datadog/Loki-style log service implemented in this repository (Fastify + TypeScript + PostgreSQL). Every document is grounded in the real codebase — code quotes, measured numbers, and `file:line` references all point at the actual implementation.

**Contract context**: 15,000 logs/s ingestion on a 0.5 CPU / 256 MB app container, 1M+ rows on 1 CPU / 1 GB PostgreSQL, p95 aggregate latency < 1 s, `docker compose up` as the entire setup.

## Table of contents

| # | Document | Status |
|---|---|---|
| 01 | [Project Overview](01-project-overview.md) | written |
| 02 | [How Datadog and Loki Work](02-how-loki-datadog-work.md) | written |
| 03 | [API Contract](03-api-contract.md) | written |
| 04 | [REST API Design](04-rest-api-design.md) | written |
| 05 | [Docker](05-docker.md) | written |
| 06 | [Database Schema](06-database-schema.md) | written |
| 07 | [Ingestion Coalescing Writer](07-ingestion-coalescing-writer.md) | written |
| 08 | [Validation](08-validation.md) | written |
| 09 | [Querying](09-querying.md) | written |
| 10 | [Aggregation](10-aggregation.md) | written |
| 11 | [Pagination & Keyset Cursors](11-pagination-keyset.md) | written |
| 12 | [Attributes & JSONB](12-attributes-jsonb.md) | written |
| 13 | [Retention](13-retention.md) | written |
| 14 | [PostgreSQL Tuning](14-postgresql-tuning.md) | written |
| 15 | [Unnest Batching](15-unnest-batching.md) | written |
| 16 | [Indexes](16-indexes.md) | written |
| 17 | [Auth](17-auth.md) | written |
| 18 | [Load Testing](18-load-testing.md) | written |
| 19 | [Debugging](19-debugging.md) | written |
| 20 | [Performance Optimizations](20-performance-optimizations.md) | written |
| 21 | [Deployment & CI](21-deployment-ci.md) | written |
| 22 | [Final Review](22-final-review.md) | written |

## Suggested reading order

1. **01 → 02** — what the project is, and the real-world products it emulates.
2. **03 → 04** — the exact contract, and how the API surface was designed around it.
3. **05 → 06** — how it runs (Docker) and where the data lives (schema).
4. **07 → 08** — the two hottest code paths: the coalescing writer and validation.
5. **09 → 16** — querying, aggregation, pagination, JSONB, retention, PG tuning, batching, indexes.
6. **17 → 22** — auth, load testing, debugging, performance, deployment, and the final review.

Each document follows the same shape: Summary, Detailed explanation, Why this exists, Alternatives considered, Why this was chosen, Advantages / Disadvantages / Trade-offs, Code (with `file:line` references), Diagrams, Common mistakes, Optimization ideas, Interview questions & answers, and Implementation references.

## Quick reference

- Implementation README: [`../README.md`](../README.md)
- Run everything: `docker compose up -d` at the repository root
- Verify: `node scripts/smoke.mjs` (auth: `--auth --key loadgen-test-key`)
- Load test: `node loadtest/loadgen.mjs --mode mixed --rate 15000 --batch 500 --duration 70`
- Tests: `npm.cmd run test` (35) / `npm.cmd run test:integration` (39, needs `docker compose up -d`)
