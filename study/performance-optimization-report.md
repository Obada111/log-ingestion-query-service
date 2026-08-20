# Official Benchmark Optimization Report

Living record of the official-benchmark-driven optimization loop. One optimization is made, verified locally, measured with the official CLI, and only committed when the benchmark demonstrates an improvement.

Method baseline: official benchmark CLI against `./docker-compose.yml`, `--full --seed 6122026 --runner docker --generator-cpus 4`, JSON report in `benchmark-report.json`. Scores are only comparable between runs on the same machine and engine state (the CLI measures a machine speed factor each run; this machine measured 0.26x–0.34x across runs). Archive: `study/official-benchmark-2026-08-20-86.9.json`.

## Baseline record

| Date | Commit | Score | Correctness | Performance | Queries | Reliability | Throughput (load) | p95 | Aggregate p95 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| (pre-optimization) | `ae3b97b` | 44.20 | 10.5/15 | ~20/50 | ~4/15 | 10/20 | 2,398/s | 5.1 s | — | PG pegged at 100% CPU, EC 1.98%, 2 missing scenario passes. All optimizations were working-tree only. |
| 2026-08-20 #1 | `9d24ad6` | **89.86** | 15/15 | 41.0/50 | 13.87/15 | 20/20 | 14,937/s | 453 ms | 63 ms | Fresh engine, speed 0.31x, load missed only 75 k6 iterations (near generator-limit; service took everything). Errors 0.0%. |

## Optimization log

### O-1. Ingestion/aggregation rework for the 1-CPU postgres (committed `9d24ad6`)
Migrations 0002–0005 (drop `logs_pkey`, sequence CACHE 1000, 1s `log_counts` rollup, typed attributes + GIN), serial coalescing drainer with bulk `unnest` INSERT + rollup upsert in one transaction, rollup+edge-scan aggregate path, PG tuning (`synchronous_commit=off`, `wal_compression`, `gin_pending_list_limit=128MB`, autovacuum analyze thresholds), boot ANALYZE + 5s stats-freshness guard.

**Before/after**: 44.20 → 89.86; throughput 2,398 → 14,937/s; p95 5.1 s → 453 ms; errors 0.0%; all 4 scenario passes; consistency 4/4.

**Trade-offs**: `synchronous_commit=off` trades up to ~10ms of commit durability window for throughput (0.2s could be lost in a full PG crash; the contract's POST response still means "PG acknowledged"); event-consistency is bounded by the flush chunk window (≤ ~1s of traffic, plus the writer-queue drainage path).

**Conclusion**: verified improvement, kept.

### O-2. Flush chunk 2500 vs 5000 — REJECTED (no demonstrated improvement)
Hypothesis: official p95 453 ms ≈ 5000-row chunk fill (333 ms) + commit (~120 ms); cutting the chunk to 2500 would cut p95 to ~250 ms. Scoring model suggested latency was the largest score loss (perf latency component 0.122/0.3 at 453 ms).

| Run | Code | Engine state | Speed | Score | Throughput | p95 | Aggregate p95 | k6 missed (load) |
|---|---|---|---|---|---|---|---|---|
| #1 | 5000 | fresh | 0.31x | 89.86 | 14,937/s | 453 ms | 63 ms | 75 |
| #2 | 2500 | degraded | 0.34x | 77.9 | 12,779/s | 1532 ms | 231 ms | 2,664 |
| #3 | 5000 (reverted) | degraded | 0.26x | 75.8 | 12,270/s | 1433 ms | 310 ms | 3,275 |
| #4 | 5000 | fresh (engine restarted) | 0.28x | 86.9 | 14,953/s | 620 ms | 128 ms | 55 |

Runs #2/#3 were contaminated: the degraded engine state (k6 missing thousands of scheduled iterations, ~30% speed-factor swing) makes their numbers artifacts of the host, not the code. 2500 never outperformed 5000 even within those runs. Local loadgen A/B was additionally unusable: the single-threaded generator starved at 15k/s (DB row count showed 1.63M rows vs 731k reported by the generator's own stats — its window accounting is not round-trip accurate), so latency measurements were generator-limit, not service-limit.

**Conclusion**: no measured gain from halving the chunk; per-transaction index-maintenance cost is the dominant fixed cost and larger chunks amortize it (the pre-existing measured profile: 500 rows ≈ 72 ms vs 2000 ≈ 80 ms). Reverted to 5000; `INGEST_MAX_ROWS_PER_FLUSH` stays 5000 with an A/B note in `src/config.ts:49-55`.

## Machine-state variance (important for future runs)

Same code, fresh engine: 89.86 (#1, speed 0.31x) vs 86.9 (#4, speed 0.28x) — ≈3 points of pure environmental spread. Before comparing any two runs: engine must be freshly restarted, and the k6 "could not start scheduled iterations" count is the pollution gauge — a load scenario missing thousands of iterations invalidates cross-run comparison. The historical local-loadtest numbers (study/18-20) can not be mixed with CLI numbers for the same reason (different generator, different machine states).

## Next candidates (one at a time, in order)
1. Reduce aggregate p95 (63→128 ms across runs; score component 13.87/15). Largest remaining deterministic lever per the scoring model. Ideas: rollup edge-scan window reduction, prepared-statement reuse on the edge scans.
2. Ingest p95: currently flush-fill + commit bound; only uncontroversial gains are PG-side (e.g. WAL/checkpoint tuning), measured against the same fresh-engine protocol.
3. Verify behavior under the platform's own machine: final score should be re-validated on the reference hardware; all numbers in this file are from this host only.

## Current state

- Working tree matches `9d24ad6` (5000-row chunks restored), plus this report and the archived JSON.
- Official CLI runs to date on `9d24ad6`: 89.86 (#1, fresh) and 86.9 (#4, fresh). Best credible: 89.86.