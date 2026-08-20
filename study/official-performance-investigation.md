# Official Performance Investigation

Investigation only — no production code was changed. Analysis of the existing implementation and the benchmark artifacts to identify the most likely real bottlenecks, separating machine noise from code/database issues. All claims below are backed by the benchmark JSONs (`benchmarks/official-baseline-0{1,2,3}.json`), the CLI scoring source (`2026-08-18.v10`), the running resource sampler, and prior measured experiments recorded in `study/07,14,19,20`.

## Current Baseline

Three identical official runs on the same repo (`d1c4f42`) and machine. Command (unchanged): `npx --yes github:Ahmad-Abbas-Foothill/logs-benchmark-cli --compose ./docker-compose.yml --full --seed 6122026 --runner docker --json benchmark-report.json --generator-cpus 4`.

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Overall score | 76.0 | 74.8 | 69.4 |
| Correctness | 15/15 | 15/15 | 15/15 |
| Reliability | 20/20 | 20/20 | 20/20 |
| Performance | 32.4/50 | 31.1/50 | 27.9/50 |
| Queries | 8.6/15 | 8.7/15 | 6.5/15 |
| Machine speed | 0.29x | 0.27x | 0.25x |
| Throughput (load) | 13,014/s | 12,083/s | 9,691/s |
| Ingestion p95 | 1327 ms | 1402 ms | 2009 ms |
| Aggregate p95 | 353 ms | 351 ms | 474 ms |
| HTTP error rate | 0% | 0% | 0% |
| PG CPU (run 3) | — | — | avg 40.3% / max 96.6% |
| App CPU (run 3) | — | — | avg 27.7% / max 51.1% |
| Dropped iterations (load) | 2,382 | 3,499 | 6,370 |
| EC consistency | 4/4 | 4/4 | 4/4 |
| Read-after-write | 0.8% | 1.7% | 0.0% |
| Drain (Δ accepted→visible) | 0 | 0 | 0 |

Scoring model (from the CLI source): Performance = 50 × (0.4·min(1, tp/15000) + 0.3·(errors ≤0.2% ⇒ 1) + 0.2·max(0, 1 − (max(p95,100)−100)/900) + sustained bonus). Queries = 9·(1 − aggP95/500) + 6·(EC/4). Latency scores zero once p95 ≥ 1000 ms; full marks only at p95 ≤ 100 ms.

Immediate score math: every run's Performance = throughput + errors only (p95 ≥ 1000 ms ⇒ latency=0) plus the aggregate term in Queries. On the earlier healthy-engine runs (89.86 and 86.9 from a fresh Docker Desktop session) the same code produced tp ≈ 14,937–14,953/s, p95 453–620 ms, agg 63–128 ms — so the same service scores ~90 when the host cooperates and ~70–76 when it does not.

## Environment Noise (not a code problem)

1. **Host memory pressure**: 15.9 GB host RAM, ~4.1 GB free; 7.7 GiB WSL2 VM is the default (no `.wslconfig`). The VM fits its required 3.5 CPU / 2.25 GB check (`sufficient: true`), but the host is swapping-rate-limit by the end of the session.
2. **Monotonic degradation**: machine speed 0.29 → 0.27 → 0.25; load dropped iterations 2,382 → 3,499 → 6,370; throughput and p95 worsen in lockstep. Identical code moved 6.6 points across the three runs — the spread is the host, not the service.
3. **Generator starvation**: every scenario, every run: `generatorLimited: true`, `serviceLimited: false`. k6 (4 CPUs inside the same VM) cannot schedule all iterations while the service and PG also run; the load scenario is capped by generator output and the VM's schedulable CPUs, so raw tp/p95 numbers under-report the service.
4. **Read-after-write 0.8–1.7%**: informational metric in v10 (displayed, not scored). It reflects flush-batching visibility (a POST resolves at commit; a read 1–2 s later may precede the chunk that carries it). Not a defect; not a scoring lever.

Conclusion: run-to-run score movement is host/VM pressure. Only correctness (15/15) and reliability (20/20) transfer to the graded machine exactly. Performance/queries are directional here.

## Confirmed Bottlenecks

**C1 — PostgreSQL single-core saturation is the real ceiling.** (Evidence: run 3 sampled PG max 96.6% CPU during load; prior measurements in study/07/19/20: 500-row INSERT ≈ 72 ms vs 2000-row ≈ 80 ms — index maintenance, not row count, dominates; 5000-row INSERT 86 ms after the GIN-list fix vs 250 ms at the default 4 MB cap; 736 page reads/insert before `shared_buffers` was raised; full-window aggregate EXPLAIN 575 ms.) Why it matters: every 5000-row chunk pays a large fixed cost (5 btree indexes + GIN pending list + rollup upsert + WAL) serialized on one core; aggregates and autovacuum queue behind it. On a healthy engine this still allowed 14,953/s (99.7% of target), so PG has just enough headroom when the host is clean — the degraded runs push it over the edge.

**C2 — Aggregate interior scan is O(spanned-seconds × 48).** (Evidence: the benchmark's aggregate is a fixed 1-hour window, `bucket=1m`, no filters, and `since`/`until` are minute-aligned — `RUN_EPOCH = floor(now/60000)*60000` — so both sub-second edge scans are empty. The whole cost is the `log_counts` range scan over the data span: ~5–10 minutes × ~48 (`service`×`level`) combos ≈ 14–29k rows per query, at 4 queries/s concurrently with ingest. Confirmed by the query builder in `src/lib/queryParams.ts:378-408` and the `log_counts` UNIQUE index that must heap-fetch `count`.) Run-3 agg p95 474 ms collapses to this scan + contention.

**C3 — Ingest p95 is chunk-fill + commit, structurally serialized.** (Evidence: writer at `src/services/ingestWriter.ts:127-132,152-209`: one serial loop; each `commitChunk` awaits a 4-round-trip transaction; the next chunk is not even extracted or encoded until the current commit returns. `insertRows` encodes all rows into six arrays (JSON.stringify + toISOString per row ≈ 30–100 ms per 5000-row chunk on the 0.5 CPU app) strictly before `BEGIN`. The next chunk's encoding cannot overlap the current chunk's PG/network commit. On a healthy engine p95 453 ms ≈ 333 ms fill (5000 rows @ 15k/s) + ~120 ms commit; under generator starvation a burst builds queue depth and p95 stretches to 1.3–2.0 s.)

**C4 — WAL/checkpoint and autovacuum cadence contend for the single core.** (Evidence: config `docker-compose.yml:39-64`: ~20 MB/s WAL at 15k/s × ~1.4 KB/row (JSONB, `wal_compression=on`) against `max_wal_size=2GB` — checkpoint every ~100 s, each checkpointer pass writing dirty buffers on the one core; `autovacuum_analyze_threshold=2000` + scale 0.01 ⇒ at 1.5M rows ANALYZE becomes eligible every ~1.1 s of ingest and fires every 15 s (`naptime`), on top of the app's own stats-freshness guard (`src/index.ts`). `log_counts` UPDATEs create ~48 dead tuples/s; its vacuum passes fire every ~15 s.) Not measured during these runs (no pg_stat_statements snapshot taken) — quantified as needing an A/B.)

**C5 — Per-chunk transaction round-trips.** (Evidence: `INSERT_SQL`/`INSERT_COUNTS_SQL` are single-statement prepared queries; `BEGIN`, INSERT, rollup upsert, `COMMIT` = 4 extended-protocol round trips per chunk, plus ~8 MB of parameter bytes serialized (5000 × ~1.4 KB attribute+message JSON) — at 0.3x machine speed each round trip is ~1–3 ms. Real but secondary to C1/C3.)

## Suspected Bottlenecks (need controlled A/B)

**S1 — Chunk size 2500 vs 5000.** Previous experiment (2026-08-20, chunk A/B in `study/performance-optimization-report.md`) ran on a degraded engine and was inconclusive: 2500 scored 77.9 vs 5000's 75.8 in the same degraded session, then 5000 recovered to 86.9 on a fresh engine. The mechanism is real (2500 halves fill latency to ~167 ms and would improve p95 on a healthy engine) but it doubles the per-chunk fixed cost on PG (C1), which only the degraded host made decisive. Needs a paired fresh-engine A/B.

**S2 — JSONB attribute filtering (GIN) in the hot path.** Only exercised by the correctness catalog, not the perf scenarios; the GIN pending-list setting (128 MB) already moved the cleanup burst off the INSERT path. Not currently on the critical path; would only matter if the graded load mixes attribute filters.

**S3 — Pool sizing.** Read pool 10 / write pool 2 with a dedicated writer connection. No measured starvation in any scenario (writer has its own client; aggregates are only 4/s). Keep as-is; revisit only if a future load shape mixes heavy reads.

**S4 — pg_stat_statements overhead.** Enabled with `track=top`; per-statement recording on 1 CPU adds small per-query cost during the run. Diagnostic-only; keep during investigation, consider `pg_stat_statements.track=all` → `none` in a full run to A/B its cost.

## Evidence Sources

- `benchmarks/official-baseline-01.json` / `-02.json` / `-03.json` — run metrics, engine probe, machine speed, scenario tables, score components.
- `study/official-benchmark-baseline.md` — three-run variance analysis and sampler methodology.
- `study/07-ingestion-coalescing-writer.md`, `study/19-debugging.md`, `study/20-performance-optimizations.md`, `study/16-indexes.md`, `study/14-postgresql-tuning.md` — prior measured INSERT/aggregate/GC/shared_buffers/WAL/GIN experiments.
- `src/services/ingestWriter.ts` — flush loop, chunk sizing, txn structure (C3, C5).
- `src/lib/queryParams.ts:339-412` — rollup aggregate SQL, edge-scan bounds (C2).
- `src/db/migrations.ts` — logs indexes (5), `log_counts` UNIQUE (implicit btree, no `INCLUDE`), sequence cache (C1/C2).
- `docker-compose.yml:39-64` — PG tuning surface (C1/C4).
- `src/db/pool.ts` — pool split and timeouts (S3).
- CLI source (cached in `_npx`): scoring weights, benchmark window alignment, k6 scenario shapes, drain/EC/read-after-write instrumentation.

## Candidate Optimizations

1. **Writer encode/commit pipelining** (attacks C3, C5): extract and encode the next chunk's arrays while the current chunk's transaction is awaiting PG; also fetch the write client before encoding. Serial writer cycle becomes max(encode, commit) instead of encode+commit ≈ 120–160 ms → ~120 ms; drain rate and burst absorption rise without changing any SQL or PG work. Purely additive, machine-independent, no regression path on a healthy or degraded host.
2. **1-minute rollup (`log_counts_1m`)** (attacks C2): same-txn upsert in the writer + new table with `UNIQUE (bucket_ts, service, level, tenant_id) INCLUDE (count)`. Aggregate interiors answer from 1-minute buckets (all supported buckets 1m/5m/1h/1d are multiples of a minute); sub-minute segments stay on `log_counts`; sub-second edges stay on `logs`. Interior scan drops from ~14–29k rows to ~0.4–0.5k rows per query. Exact for every window; ~1–2 ms extra upsert per chunk.
3. **PG checkpoint/WAL + autovacuum budget** (attacks C4): fit `max_wal_size` to the 1 GB cgroup (e.g., 512 MB) so checkpoints are frequent but shallow; raise `autovacuum_analyze_threshold` to avoid the 15 s ANALYZE churn during a pure-ingest run (or have the app guard skip ANALYZE while stats are provably current); keep `gin_pending_list_limit` and vacuum thresholds (RETENTION creates no dead rows in a graded run).
4. **Chunk size 2500** (attacks C3 fill term) — deferred until a paired fresh-engine A/B confirms it does not lose throughput to C1.

## Priority Ranking

1. **Writer pipelining (P1)** — highest expected score gain per unit risk; machine-independent; directly lifts the single biggest deterministic loss (ingest p95, weight 0.2 of Performance) and improves degraded-host burst handling.
2. **1-minute rollup (P2)** — second-largest deterministic loss (aggregate p95, weight 9 points in Queries); low risk; tiny writer cost.
3. **PG checkpoint/WAL + autovacuum tune (P3)** — config-only, cheap, removes periodic single-core stalls; moderate, harder-to-quantify gain; also improves degraded-host behavior.
4. **Chunk size A/B (P4)** — deferred, requires a paired fresh-engine protocol; potential to cut p95 fill term by ~180 ms but risks PG CPU (C1).

## A/B Test Plan

Fixed protocol for every experiment (this machine):
1. Restart Docker Desktop; close heavy apps; confirm host free RAM > 8 GB and engine idles.
2. Run the exact official command once on the untouched commit as the same-session baseline.
3. Validate the run is comparable: `machineSpeed.factor` within ±0.02 of the baseline run and load dropped iterations within 1.5× (else abort and re-run both).
4. Apply exactly ONE change (config or code), `docker compose up --build`, run the official command again.
5. Compare load throughput, ingestion p95, aggregate p95, PG max CPU (sampler running during the run), score delta, correctness/reliability (must stay 15/15 and 20/20).
6. Accept only if the score delta is ≥ +1.5 points at comparable host state AND no component regresses; otherwise revert and document.
7. Archive JSONs into `benchmarks/`; update `study/performance-optimization-report.md`.

## Risks and Trade-offs

- Pipelining: +1 chunk of buffered encoded data (~6–8 MB) in the app (256 MB cap, headroom ~140 MB); FIFO order and failure semantics unchanged (a failed chunk still rejects every batch in it, exactly once).
- 1m rollup: one more table/index (small: ~8–10 rows × 48 per minute of data) and a second upsert in each chunk txn (~1–2 ms); correctness of the new segmentation is provable and covered by the existing aggregate integration suite.
- WAL/autovacuum: config only; wrong sizing risks premature checkpoints or OOM within the 1 GB cap, so the new `max_wal_size` must be A/B's with the memory sampler.
- Chunk size: must not be changed outside a paired A/B; the earlier attempt's failure was host contamination, not a proven code regression.

## Expected Impact

On a healthy engine (89.86 reference): P1 alone is expected to move ingestion p95 from ~453 ms toward ≤ ~360 ms (score + ~0.8–1.2) and to absorb generator bursts; P2 expected to move aggregate p95 from ~63–128 ms to ~25–40 ms (Queries 13.87 → ~14.2–14.5). On the degraded host, P1+P2 reduce queue depth and scan work proportionally and should move the 69–76 runs up several points without correctness risk. P3 removes periodic stalls that are amplified on this host.

## Top 3 Next Optimizations

### 1. Writer encode/commit pipelining
- **What**: Restructure `flush()` so the next chunk's six parameter arrays are built (JSON.stringify/toISOString per row) *before* awaiting the current chunk's commit; acquire the write-pool client up front; resolve each chunk only after its own commit.
- **Why**: The serial writer's cycle is currently encode-then-commit; the encode (pure app CPU, ~30–100 ms/chunk on 0.5 CPU) idles during the ~120 ms PG/network commit. Overlapping them shortens the writer cycle and drains bursts faster, cutting ingestion p95 (weight 0.2 of Performance) and the degraded-host queue spikes. No SQL change.
- **How benchmarked**: one code change → full test suite → official run vs same-session baseline (protocol above), sampler capturing app/PG CPU.
- **Metric that should improve**: ingestion p95 (load), then Performance score; throughput at comparable host state should not regress.

### 2. One-minute rollup for aggregate interiors
- **Status**: attempted 2026-08-20 and **reverted** on the A/B gates (see Optimization #2 below); implementation was proven exact locally (0 bucket mismatches, suite green) but the same-session run regressed on score, aggregate p95, load drops and EC.
- **What**: Migration `0006`: `log_counts_1m (bucket_ts, service, level, tenant_id, count)` with `UNIQUE (…) INCLUDE (count)`; same-transaction upsert `date_bin('1 minute', ts)` in the writer; aggregate builder (rollup path only) answers whole minutes from `log_counts_1m`, sub-minute from `log_counts`, sub-second from `logs` with disjoint, clamped segments.
- **Why**: The benchmark aggregate scan is O(spanned seconds × 48); a minute rollup makes the interior ~30–60× smaller while staying exact for every window and bucket size (1m/5m/1h/1d all divide minutes).
- **How benchmarked**: migration + writer + query builder → unit + integration (aggregate exactness across shapes) → official run vs same-session baseline.
- **Metric that should improve**: aggregate p95 (Queries score; 9 points of the total) and reduced PG CPU from 4/s scan workload.

### 3. PG checkpoint/WAL + autovacuum budget
- **Status**: attempted 2026-08-20, result **inconclusive and reverted** (see Optimization #3 below) — same-session baseline leg ran on a degraded host (machine speed 0.24x, 2,935 load rejects) while the tuned leg hit the best host state observed (0.28x, 33 rejects), so the score delta could not be validated; DB-level counters could not be captured (CLI tears the stack down at the end; the attached live poller silently failed), so per protocol the change was reverted rather than kept unproven. The exact 6-flag diff is recorded in the Optimization #3 section for a confirmatory run.
- **What**: Config-only: fit `max_wal_size` to the 1 GB cgroup (e.g., 512 MB, with `min_wal_size` ~128 MB) so checkpoint write-back is shallow and frequent rather than a multi-second stall each ~100 s; raise autovacuum ANALYZE thresholds/scale so a pure-ingest run isn't re-analyzed every 15 s on the single core (and align the app's stats guard so it does not duplicate that work).
- **Why**: Each checkpoint and ANALYZE costs seconds on the one PG CPU and amplifies p95 under host pressure; these are free-standing tunables with a direct A/B.
- **How benchmarked**: config diff only → `docker compose up` → official run vs same-session baseline, with `pg_stat_statements`/sampler output for checkpoint counts and PG CPU.
- **Metric that should improve**: ingestion p95 and PG max CPU (removes periodic stalls), throughput stability across the full run; score should not regress elsewhere.

## Optimization #1 — Writer Encode/Commit Pipelining

Status: **EXPERIMENT RUN AND REVERTED** (2026-08-20). The change was implemented, verified locally, benchmarked head-to-head against a fresh-engine same-day baseline, and did not clear the acceptance gates. Per protocol the code was reverted immediately; only the artifacts, the A/B record, and this documentation remain. **No performance code change is in the tree.**

### Hypothesis
The writer cycle is serial: chunk N's encode (pure app CPU, ~30–100 ms per 5000-row chunk on the 0.5-CPU app) runs strictly before chunk N's 4-round-trip transaction, and chunk N+1 is not even extracted or encoded until chunk N's COMMIT returns (C3). By overlapping chunk N+1's encoding with chunk N's database work, the writer cycle becomes max(encode, commit) instead of encode + commit, shortening the drain and reducing queue-depth spikes → lower ingestion p95 (weight 0.2 of Performance) with no SQL, schema, or PG work change.

### Implementation (code was reverted; description retained for the record)
`src/services/ingestWriter.ts` `flush()` was restructured (single file, ~90-line net diff):
- `tryEncode(chunk)` builds the six parameter arrays (toISOString/JSON.stringify) synchronously, pure CPU; returns a `PreparedChunk`.
- `commitPrepared(prepared)` runs the existing 4-statement transaction (`BEGIN`, `INSERT_SQL`, `INSERT_COUNTS_SQL`, `COMMIT`) from precomputed arrays, with the existing one-retry-then-reject-all semantics.
- `flush()` loop: `commitP = commitPrepared(prepared)` → `nextPrepared = tryEncode(takeChunk())` → `await commitP` → swap. The encode of chunk N+1 executes while chunk N's commit awaits PostgreSQL.

### Concurrency model
Exactly one transaction in flight at any time; exactly one prepared chunk (bounded lookahead of 1). No concurrent writes, so PG-side ordering and visibility across chunks are identical to the serial implementation — a POST resolves only after *its own* chunk commits. FIFO drain order preserved (`takeChunk` unchanged).

### Backpressure model
Queue semantics unchanged (size-first trigger + wait timer + flush-on-arrival loop); the pipeline adds at most one encoded chunk (~6–8 MB) of app memory (256 MB cap, headroom ~140 MB). Empty tail chunks terminate the loop (guard added; the naive version looped forever on an empty tail).

### Failure propagation and shutdown
Encode failure rejects that chunk's batches immediately (deterministic, non-retryable); commit failure keeps the existing single retry then rejects every batch in the chunk — never a silent success. `end()` unchanged (clears timer, closes write pool).

### Durability / correctness invariance
The transaction text and order are unchanged; the retry reuses the same prepared arrays (a failed transaction did not mutate them); resolves still happen only after COMMIT acknowledgment. Correctness suite green before the A/B: typecheck, lint, 37/37 unit, 39/39 integration, contract smoke PASS.

### Before (baseline) — fresh-engine same-day run on untouched commit `dfef261`
`benchmarks/writer-pipeline-baseline.json`:
- Score 75.69 (Perf 31.99 / Queries 8.70 / Correctness 15 / Reliability 20), machine speed **0.232x**
- Load: 12,742/s, p95 **1414 ms**, agg p95 350 ms, errors 0%, dropped k6 iterations **2,709**
- Sampler: PG avg 21.2% / max 99.3% CPU, 552/847 MiB; app avg 16.2% / max 55.3% CPU, 59/117 MiB

### After (optimized) — fresh engine restart, same session
`benchmarks/writer-pipeline-optimized.json`:
- Score 71.50 (Perf 28.65 / Queries 7.85 / Correctness 15 / Reliability 20), machine speed **0.237x**
- Load: 10,238/s, p95 **1644 ms**, agg p95 397 ms, errors 0%, dropped k6 iterations **5,713**
- Sampler: PG avg 34.3% / max 101.1% CPU, 524/845 MiB; app avg 23.4% / max 53.1% CPU, 57/116 MiB

### Deltas and gates
| Gate | Requirement | Result |
|---|---|---|
| score | ≥ +1.5 | **−4.19** (75.69 → 71.50) — FAIL |
| machineSpeed | within ±0.02 | 0.232 → 0.237 (Δ 0.005) — pass |
| load dropped iterations | within 1.5× | 2,709 → 5,713 (**2.11×**) — **FAIL** |
| correctness / reliability | 15/15, 20/20 | unchanged — pass |
| errors | no unexplained increase | 0% → 0% — pass |
| aggregate/query regression | none | agg 350 → 397 ms, Queries 8.70 → 7.85 — regressed with the run |

Throughput −19.6%, ingestion p95 +230 ms, both inside the identical-code band observed on this machine (±6.6 points, 69.4–76.0 over three runs of unchanged code; load drops 2,382–6,370 in that band). The optimized run's host state was visibly worse: load drop count 2.11× the baseline, PG avg CPU +13 pts, app avg CPU +7 pts, k6 stress/spike/breakpoint memory and CPU all above baseline. No CLI warning beyond the standard generator-limited note.

### Verdict
**REVERTED — not accepted.** The machine-speed gate passed but the dropped-iterations gate failed (2.11× > 1.5×) and the measured delta was negative and below the +1.5 acceptance threshold. Because even identical code moves 6.6 points and the load drop counts moved 2.11×, neither outcome can be attributed to the change; the mechanism (reduced deterministic p95 floor) was not observable under this host's noise. Per protocol the code was removed and the experiment is recorded here. A future attempt must first demonstrate a comparable host (fresh engine + matched load drops) and should prefer re-running the pipelined A/B on a session with the machine in a stable band. Artifacts archived: `benchmarks/writer-pipeline-baseline.json`, `benchmarks/writer-pipeline-optimized.json`. Reverted commit is uncommitted (git restore of `src/services/ingestWriter.ts` to `dfef261`).

## Optimization #2 — One-Minute Rollup for Aggregate Interiors

Status: **EXPERIMENT RUN AND REVERTED** (2026-08-20). The change was implemented, verified exact locally, benchmarked head-to-head against a fresh-engine same-day baseline, and did not clear the acceptance gates. Per protocol the code was reverted immediately; only the artifacts, the A/B record, and this documentation remain. **No performance code change is in the tree.**

### Hypothesis
The benchmark's aggregate queries spend their interior scan in `log_counts` (1-second granularity): ~48 rows × 60 per minute of window, up to ~173k rows scanned per query on the single PG core. A 1-minute rollup (`log_counts_1m`) shrinks the interior ~30–60× while staying exact for every window and bucket size (1m/5m/1h/1d all divide minutes; sub-second edges and partial minutes stay on the fine-grained tables). Expected: lower aggregate p95 (Queries score, 9 points of the total) and lower PG CPU under the 4/s scan workload.

### Implementation (code was reverted; description retained for the record)
- `src/db/migrations.ts` — migration `0006`: `CREATE TABLE log_counts_1m (bucket_ts timestamptz, service text, level text, tenant_id text, count bigint)` with `CREATE UNIQUE INDEX log_counts_1m_pkey ON log_counts_1m (bucket_ts, service, level, tenant_id) INCLUDE (count)`, plus a backfill `INSERT … SELECT date_bin('1 minute', bucket_ts) … FROM log_counts GROUP BY …` executed at migrate time.
- `src/services/ingestWriter.ts` — the chunk transaction now runs `INSERT_COUNTS_1M_SQL` (same `ON CONFLICT … DO UPDATE` upsert semantics, `date_bin('1 minute', ts)`) inside the same transaction after `INSERT_COUNTS_SQL`; atomicity with the raw writes and second-level counts is unchanged (POST 200 only after COMMIT).
- `src/lib/queryParams.ts` — rollup path segments the window: minutes fully inside the window answered from `log_counts_1m`; the sub-minute head/tail from `log_counts`; sub-second bucket edges from `logs`, all clamped and disjoint. Minute-range bounds are inlined as literals (parameterizing them changed the planner's cast handling and broke exact bucket alignment during development; verified both ways).
- `src/index.ts` — boot/guard `ANALYZE` now covers `log_counts_1m` alongside `log_counts`.
- Tests updated for the new table (`tests/unit/queryParams.ts` + `tests/integration/api.test.ts`/`helpers.ts` truncate `log_counts_1m`).

### Correctness verification (before the A/B)
- typecheck + lint clean; 37/37 unit, 39/39 integration, contract smoke PASS.
- Local proof on a seeded 10-minute dataset: new builder vs old builder on identical data — 10/10 buckets, **0 mismatches**; new 1.6 ms / 46 buffers vs old 11.1 ms / 214 buffers on a quiet single-core PG.
- HTTP spot-checks exact on: mid-minute windows, service grouping, 5m and 1h buckets.

### Before (baseline) — fresh-engine same-day run on untouched commit `a82bc03`
`benchmarks/rollup-baseline.json`:
- Score **85.25** (Perf 38.14 / Queries 12.10 / Correctness 15 / Reliability 20), machine speed **0.295x**
- Load: 14,932/s, p95 **709 ms**, agg p95 **161 ms**, errors 0%, dropped k6 iterations **81**
- All scenarios EC, drain deltas 0
- Sampler: PG avg 19.8% / max 94.7% CPU; app avg 14.7% / max 51.4% CPU

### After (optimized) — fresh engine restart, same session, rollup live
`benchmarks/rollup-optimized.json`:
- Score **76.61** (Perf 33.77 / Queries 7.84 / Correctness 15 / Reliability 20), machine speed **0.291x**
- Load: 14,076/s, p95 **1154 ms**, agg p95 **231 ms**, errors 0%, dropped k6 iterations **1,108**
- Drain deltas: stress accepted 1,863,300 / visible 429,000; breakpoint accepted 1,103,800 / visible 351,000; **EC 2/4** (load + spike pass)
- Sampler: PG avg 30.9% / max 99.5% CPU; app avg 22.9% / max 52.2% CPU

### Deltas and gates
| Gate | Requirement | Result |
|---|---|---|
| score | ≥ +1.5 | **−8.64** (85.25 → 76.61) — FAIL |
| machineSpeed | within ±0.02 | 0.295 → 0.291 (Δ 0.004) — pass |
| load dropped iterations | within 1.5× | 81 → 1,108 (**13.7×**) — **FAIL** |
| correctness / reliability | 15/15, 20/20 | unchanged — pass |
| errors | no unexplained increase | 0% → 0% — pass |
| aggregate/query improvement | agg p95 improves meaningfully, Queries improves | agg 161 → **231 ms (+70 ms)**, Queries 12.10 → 7.84 — **FAIL** (regressed with the run) |
| consistency | no regression vs baseline | EC 4/4 → **2/4** with drain deltas — **FAIL** |

### Drain-delta analysis
The CLI's consistency probe (per its bundled source) first asks the 1-day aggregate for the drain service (10 s timeout; aborts if its companion probe-service count is non-zero), and on any failure falls back to a paginated `GET /logs` cursor walk with a 2 s per-request cap and a bounded drain window — a walk that can only report what it finished reading. On the optimized run the aggregate fallback was hit under saturated single-core PG and the walks returned partial counts (429k / 351k of the accepted totals), which is why drain deltas appeared for the first time this session. This is a measurement-window artifact of the heavier run, not raw-write loss: each accepted chunk commits atomically (logs + both count tables) before the POST 200 and the error rate stayed 0%. However, EC 4/4 → 2/4 is a same-session regression on an established CLI metric and is counted against the experiment regardless of mechanism.

### Verdict
**REVERTED — not accepted.** Score −8.64 and Queries −4.26 both well below the +1.5 threshold, aggregate p95 regressed (+70 ms) rather than improving, load dropped iterations moved 13.7× the paired baseline (gate limit 1.5×), and EC consistency dropped to 2/4. Because identical code has moved 9 points across sessions (69.4–76.0 band vs today's 85.25 baseline) and the two runs' load-drop counts differ by 13.7×, the host states are not comparable and the rollup's (locally-proven) effect could not be observed or validated. Per protocol the code was removed (git restore of `src/db/migrations.ts`, `src/index.ts`, `src/lib/queryParams.ts`, `src/services/ingestWriter.ts` and the three test files back to `a82bc03`). Artifacts archived: `benchmarks/rollup-baseline.json`, `benchmarks/rollup-optimized.json`. A future attempt must first demonstrate host comparability (fresh engine, matched load drops) and should additionally gate on host CPU bands before the score gate is read.

## Optimization #3 — PostgreSQL Checkpoint/WAL/Autovacuum Tuning

Status: **EXPERIMENT RUN — INCONCLUSIVE, CONFIG CHANGE REVERTED** (2026-08-20). The six-flag PostgreSQL configuration change was benchmarked head-to-head on a fresh engine in a single session. The two legs landed on very different host states (the baseline leg on the degraded band, the tuned leg on the best band ever observed), so the score delta cannot be validated; and a poller failure lost the in-database checkpointer/WAL/analyze counters that the protocol requires before keeping a change. Per protocol the change was reverted; the full diff is recorded here for a confirmatory attempt. **No configuration change is in the tree.**

### Hypothesis
PostgreSQL is capped at 1 CPU and reached ~100% during every official run. Two background costs were suspected of contributing: (a) checkpointing — with `checkpoint_timeout=15min` and `max_wal_size=2GB`, a checkpoint after heavy ingest turns into a multi-second synchronized write-back of hundreds of MB of dirty pages and WAL recycling, contending with the write path on the single core; (b) analysis — with `autovacuum_naptime=15s`, `autovacuum_analyze_threshold=2000`, `autovacuum_analyze_scale_factor=0.01`, autovacuum re-analyzed the fast-growing tables almost every naptime window (at 12–15k rows/s the `logs` churn exceeds the threshold in seconds), duplicating the app's own stats guard (`src/index.ts` re-analyzes `logs`/`log_counts` whenever stats are >10 s stale), and every ANALYZE competes for the same core.

### Current configuration (measured live before the experiment, `pg_settings`)
`shared_buffers=512MB`, `work_mem=16MB`, `maintenance_work_mem=128MB`, `wal_buffers=16MB`, `max_wal_size=2GB`, `min_wal_size=256MB`, `checkpoint_timeout=15min`, `checkpoint_completion_target=0.9`, `checkpoint_flush_after=256kB` (default), `autovacuum=on`, `autovacuum_max_workers=3`, `autovacuum_naptime=15s`, `autovacuum_vacuum_cost_limit=-1` (200), `autovacuum_vacuum_cost_delay=2ms`, `autovacuum_analyze_scale_factor=0.01`, `autovacuum_analyze_threshold=2000`, `autovacuum_vacuum_scale_factor=0.05` (default), `autovacuum_vacuum_threshold=50000` (default), `log_checkpoints=on`, `synchronous_commit=off`, `wal_compression=pglz`, `gin_pending_list_limit=128MB`, `max_parallel_workers_per_gather=0`, `effective_cache_size=768MB`, `max_connections=50`. PostgreSQL 16 (postgres:16-alpine).

### Measurements before (baseline leg) — fresh engine, current config, same session
`benchmarks/pg-baseline.json`:
- Score **75.60** (Perf 31.74 / Queries 8.86 / Correctness 15 / Reliability 20), machine speed **0.2408x**
- Load: 12,554/s, p95 **1434ms**, agg p95 **341ms**, errors 0%, dropped k6 iterations **2,935**
- Stress 9,205/s (agg 600ms, drops 17,692); spike 9,658/s (agg 501ms, drops 5,717); breakpoint 9,879/s (agg 593ms, drops 17,393)
- Consistency: EC 4/4, all visible == accepted (no drain deltas), errors 0%
- Sampler: PG avg 33.5% / max 100.8% CPU; app avg 24.3% / max 51.9% CPU

### Changeset (exact diff; reverted after the experiment)
| Parameter | Before | After | Rationale |
|---|---|---|---|
| `checkpoint_timeout` | 15min | 5min | Bounds every checkpoint burst to ≤5 minutes of accumulated work regardless of WAL rate; a 15-minute accumulation was the multi-second stall candidate on the single core. |
| `max_wal_size` | 2GB | 512MB | The 2GB cap (vs 1GB cgroup) let WAL pile up for a 15-minute megaburst; 512MB keeps recycling shallow. With `checkpoint_completion_target=0.9` (unchanged) each burst's writes are spread over 4.5 minutes. |
| `min_wal_size` | 256MB | 128MB | Keeps ~128MB of recyclable WAL for crash-restore headroom without forcing segment churn, matched to the smaller max. |
| `autovacuum_naptime` | 15s | 60s | Cuts background worker wakeups from ~4/min to ~1/min on the contended core; vacuum/analyze latency of ≤1 min is irrelevant to the workload. |
| `autovacuum_analyze_threshold` | 2000 | 10000 | So `logs`'s 12–15k rows/s churn no longer triggers autoanalyze every naptime cycle. |
| `autovacuum_analyze_scale_factor` | 0.01 | 0.05 | Further defers autoanalyze as tables grow. Freshness is not abandoned: the app's stats guard (unchanged) re-analyzes `logs`/`log_counts` within ~10 s whenever stats age — this change only removes the *duplicated* autoanalyze storms, which is the entire point. |

No resource limits changed. No app code touched. The change is 6 flags in `docker-compose.yml` (commented in-file).

### Measurements after (tuned leg) — fresh stack, same session
`benchmarks/pg-optimized.json`:
- Score **87.00** (Perf 39.19 / Queries 12.77 / Correctness 15 / Reliability 20), machine speed **0.2826x**
- Load: 14,972/s, p95 **619ms**, agg p95 **124ms**, errors 0%, dropped k6 iterations **33**
- All scenarios EC 4/4, all visible == accepted, errors 0%
- Sampler: PG avg 31.5% / max 96.3% CPU; app avg 23.8% / max 51.6% CPU

### Deltas and gates
| Gate | Requirement | Same-session result |
|---|---|---|
| machineSpeed | within ±0.02 | 0.2408 → 0.2826 (Δ **0.042**) — **FAIL** (hosts differ) |
| load dropped iterations | within 1.5× | 2,935 → 33 (**~90×**) — **FAIL** (hosts differ) |
| score | ≥ +1.5, comparable host | +11.40 — cannot be attributed to the change alone |
| correctness / reliability | 15/15, 20/20 | 15/15, 20/20 both legs — pass |
| consistency / errors | no regression | EC 4/4 both legs, drain deltas 0 both legs, 0% errors — pass |
| aggregate p95 | no regression | 341 → 124ms baseline-pair; 161 → 124ms vs best-state identical-code run — improved |
| load throughput | no regression | 12,554 → 14,972/s (baseline-pair); 14,932 → 14,972/s (best-state pair) — improved |
| ingestion p95 | improve meaningfully | 1434 → 619ms (baseline-pair); 709 → 619ms (best-state pair) — improved |

Cross-session best-state pairing (identical code, `benchmarks/rollup-baseline.json`: 85.24 / 0.2946x / 81 drops / agg 161ms — the best host state ever observed): the tuned leg at 0.2826x (Δ −0.012 within ±0.02) and 33 drops (within 1.5× of 81) meets the comparability gates, and every graded metric improved (score 87.00 vs 85.24, agg p95 124 vs 161ms, Queries 12.77 vs 12.10, ingestion p95 619 vs 709ms) with correctness/reliability/EC held. PG-efficiency signal (directional, hosts differ): rows·s⁻¹ per PG CPU point rose from 12,554/33.5 = 375 to 14,972/31.5 = 475 (+27%) — more throughput on *less* average PG CPU, consistent with fewer ANALYZE storms and shallower checkpoints.

### What could not be measured
In-database counters (checkpoint count/write-time/sync-time, WAL bytes, autoanalyze/autovacuum counts, dead-tuple levels, WAL-dir growth) from either leg could not be recovered: the CLI tears the stack down (and removes its volume) at the end of a run, and the live poller attached to the tuned leg silently failed to log. The protocol requires database-level evidence before keeping a change whose score signal sits on non-comparable host states — that evidence is absent, so the experiment can only be recorded as inconclusive.

### Verdict
**INCONCLUSIVE — configuration change REVERTED.** Nothing regressed in any metric on any leg (throughput, both p95s, CPU, reliability, consistency all equal-or-better; 15/15, 20/20, EC 4/4, 0% errors, zero drain deltas in both legs), and the mechanism is coherent with the measured behavior. But the same-session A/B landed on host states that fail the machine-speed (±0.02) and dropped-iterations (1.5×) comparability gates by a wide margin, and the database-level measurements were lost to a poller failure — two of the three planks the protocol needs for a validated keep. Per the protocol ("do not keep a configuration change just because one metric improved"; "report the benchmark as inconclusive"), the change was reverted (`git restore docker-compose.yml` back to `4c39675`). The exact 6-flag diff above is the reapply recipe for a confirmatory A/B, which must: (1) run a fresh-engine baseline and tuned leg in the SAME host band (machine speed ±0.02, load drops within 1.5×), and (2) attach a working live PG poller to *both* legs from start to end to capture checkpointer/WAL/analyze deltas before the CLI's teardown. Artifacts archived: `benchmarks/pg-baseline.json`, `benchmarks/pg-optimized.json`.