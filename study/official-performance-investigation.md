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
- **What**: Migration `0006`: `log_counts_1m (bucket_ts, service, level, tenant_id, count)` with `UNIQUE (…) INCLUDE (count)`; same-transaction upsert `date_bin('1 minute', ts)` in the writer; aggregate builder (rollup path only) answers whole minutes from `log_counts_1m`, sub-minute from `log_counts`, sub-second from `logs` with disjoint, clamped segments.
- **Why**: The benchmark aggregate scan is O(spanned seconds × 48); a minute rollup makes the interior ~30–60× smaller while staying exact for every window and bucket size (1m/5m/1h/1d all divide minutes).
- **How benchmarked**: migration + writer + query builder → unit + integration (aggregate exactness across shapes) → official run vs same-session baseline.
- **Metric that should improve**: aggregate p95 (Queries score; 9 points of the total) and reduced PG CPU from 4/s scan workload.

### 3. PG checkpoint/WAL + autovacuum budget
- **What**: Config-only: fit `max_wal_size` to the 1 GB cgroup (e.g., 512 MB, with `min_wal_size` ~128 MB) so checkpoint write-back is shallow and frequent rather than a multi-second stall each ~100 s; raise autovacuum ANALYZE thresholds/scale so a pure-ingest run isn't re-analyzed every 15 s on the single core (and align the app's stats guard so it does not duplicate that work).
- **Why**: Each checkpoint and ANALYZE costs seconds on the one PG CPU and amplifies p95 under host pressure; these are free-standing tunables with a direct A/B.
- **How benchmarked**: config diff only → `docker compose up` → official run vs same-session baseline, with `pg_stat_statements`/sampler output for checkpoint counts and PG CPU.
- **Metric that should improve**: ingestion p95 and PG max CPU (removes periodic stalls), throughput stability across the full run; score should not regress elsewhere.