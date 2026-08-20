# PostgreSQL Counter Capture — Optimization #3 Confirmatory A/B

## Experiment Design

- **Objective**: Determine whether the six PostgreSQL configuration changes (checkpoint_timeout 15min→5min, max_wal_size 2GB→512MB, min_wal_size 256MB→128MB, autovacuum_naptime 15s→60s, autovacuum_analyze_threshold 2000→10000, autovacuum_analyze_scale_factor 0.01→0.05) are responsible for the large benchmark improvement observed in the first A/B run.

- **Baseline leg** (no config change): Fresh engine restart, same Docker/WSL host, `benchmark-report-pg-confirm-baseline.json`. Machine speed 0.26x, load drops 4,147, throughput 11,543/s, agg p95 354ms, ingestion p95 1,564ms, score 74.0.

- **Tuned leg** (6 flags applied): Same engine session after baseline, `benchmark-report-pg-confirm-optimized.json`. Machine speed 0.29x, load drops 549, throughput 14,542/s, agg p95 247ms, ingestion p95 1,031ms, score 79.9.

- **PG metrics captured**: Continuous polling of `pg_stat_bgwriter`, `pg_stat_wal`, `pg_stat_user_tables`, and `pg_ls_waldir` at 8-second intervals from just after the preparation phase through the end of the breakpoint scenario, writing one JSON line per tick to `pg-count-capture.log`.

## Host Gating

- **machineSpeed**: 0.26x → 0.29x (Δ 0.03) — fails the ±0.02 comparability gate.
- **dropped iterations**: 4,147 → 549 (~7.6×) — fails the 1.5× comparability gate.
- **Result**: same-session A/B pair is **incomparable** per protocol; score delta cannot be attributed solely to the config change.

## PostgreSQL Counter Evidence

The poller captured 216 JSON samples from the tuned leg and 111 from the baseline leg. Key deltas (baseline→tuned):

### Analyze / Autovacuum (STORM ELIMINATED)
- `logs` autoanalyze: 24 → **0**; `log_counts` autoanalyze: 17 → **0**.
- `logs` autovacuum: 15 → **3**; `log_counts` autovacuum: **1**.
- `logs` dead tuples: **580,283 → 0** (elimination of the storm).
- `log_counts` dead tuples: **14,916 → 96**.
- `max_wal_size` footprint: **2,147 → 520 MB** (4× smaller on-disk WAL directory).

These numbers confirm that raising the autovacuum thresholds and scaling factor, together with the longer naptime, definitively removed the analyze/vacuum storms that were hammering the single core.

### Checkpoint / WAL (MECHANISM MIXED — REFUTED for observed WAL rate)
- `checkpoints_timed`: **0 → 0** (no timed checkpoints in either leg; WAL-driven checkpoints dominate).
- `checkpoints_req` (requested, WAL-forced): **4 → 22** (the 512MB cap is exhausted every ~90s at the measured ~336MB/min WAL generation rate, not 5 min as assumed; 22 requests across ~14.8 min).
- `checkpoint_write_time`: **460 → 675 seconds** (total checkpointer CPU time **+46%**; +28% per WAL MB).
- `buffers_checkpoint`: **136,796 → 445,578** (+225% more buffers written overall).
- `wal_bytes` generated: **5,102 → 5,864 MB** (higher ingest volume in tuned leg).
- `waldir` peak: **2,147 → 520 MB** (4× smaller disk footprint — the only clean checkpoint-win).
- `maxwritten_clean`: **355 → 59** (bgwriter stopped early less often, indicating more frequent checkpoint cycles).
- `wal_fpi`: **39,082 → 36,507** (slightly fewer full-page images).

**Interpretation**: The WAL ingestion rate (~336 MB/min, derived from 5,102 MB over baseline 15.2 min; 5,864 MB over tuned 14.8 min) refutes the design assumption that 512MB / 5 min would keep checkpoints shallow. The tunings produced **22 rapid WAL-forced checkpoints** (~40s interval) instead of the desired 5-min timed cadence, and the total checkpoint write work INCREASED (more frequent full-pool flushes). The checkpoint half of the hypothesis is **refuted for the observed WAL generation rate**.

### PG CPU Efficiency
- Baseline: avg 28.6% / max 94%; Tuned: avg 28.1% / max 96.2% — essentially flat.
- **Throughput normalized**: baseline 11,543/s per 28.6 CPU-pt = 404 rows·s⁻¹ per CPU-pt; tuned 14,542/s per 28.1 CPU-pt = 517 rows·s⁻¹ per CPU-pt (+28%).
- The analyze/vacuum savings freed enough CPU to offset the higher checkpoint overhead; net background cost per run-minute was essentially unchanged, while throughput rose due to the host-band advantage + analyze kill.

## Final Verdict

- **Host comparability**: FAILED (machineSpeed Δ0.03 > ±0.02; dropped-iterations ratio 7.6× > 1.5×). Per the mandate, the score delta cannot be validated from this same-session A/B.
- **Database-level mechanism**: Mixed — analyze storm **confirmed eliminated**, checkpoint flattening **refuted** (frequent small checkpoints raised total work under the actual WAL rate).
- **Overall result per protocol**: **INCONCLUSIVE**. Neither the host comparability plank nor the full DB-mechanism plank supports a clean keep; however, the analyze-vacuum storm removal is a genuine win, and the config is a low-risk 6-flag diff that can be re-applied in a future confirmatory run with a host-matched pair or with WAL-rate-aware sizing.
- **Action taken**: Baseline config **restored** (`docker-compose.yml` git‑restored to `4c39675`). The 6‑flag diff is recorded in the study documentation for a future confirmatory attempt (with host-matched legs and a WAL-rate‑aware max_wal_size design). No performance code change remains in the tree.

## Files in this directory

- `pg-confirm-optimized-counters.log` — 216 raw JSON samples from the tuned leg (continuous poller output).
- `pg-confirm-baseline-summary.md` — derived summary of baseline leg counters from the live capture (111 samples, all deltas; see transcript for exact derivation).
- `README.md` — this file.