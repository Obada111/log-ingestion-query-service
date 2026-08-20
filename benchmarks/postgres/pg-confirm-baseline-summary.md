# PostgreSQL Counter Capture — Optimization #3 Confirmatory A/B (Baseline Derived Summary)

**Source**: pg-count-capture.log (111 timed samples, span 15.2 min from baseline leg of confirmatory A/B). 
**Note**: Raw JSON lines were lost during a local file‑copy error; this summary is computed from the live‑capture log and cross‑checked against the transcript deltas printed at runtime.

- **json samples**: 111
- **sample span**: 15.2 min (from just after preparation through the breakpoint scenario)
- **cp_timed** (timed checkpoints): **0 → 0** (no timed checkpoints fired; all were WAL‑driven)
- **cp_req** (WAL‑forced requests): **1 → 4** (4 checkpoints requested when WAL exceeded the 2 GB cap)
- **cp_write_ms** (checkpointer write time): **29 → 460,124 ms** (total checkpointer CPU seconds; baseline spent ~7.7 min writing)
- **cp_sync_ms** (checkpoint sync time): **81 → 364 ms**
- **cp_bufs** (buffers written by checkpoints): **923 → 136,796** (~1.07 GB of page writes)
- **backend_bufs** (buffers written by backends): **296 → 289,512**
- **backend_fsync**: **0 → 0**
- **maxwritten_clean**: **0 → 355** (bgwriter stopped‑early counter)
- **wal_bytes** (WAL volume generated): **6.9 → 5,102.1 MB** (~336 MB/min)
- **wal_records**: **25,229 → 36,051,579**
- **wal_fpi**: **1,418 → 40,500** (full‑page images)
- **waldir peak MB**: **2,147 MB** (on‑disk WAL directory peak size)
- **log_counts** table deltas (ana/autoana/vac/autovac / live_tup / dead_tup):
  - ana: **61** (app‑guard ANALYZE calls); autoana: **17**; vac: **0**; autovac: **2**; live_end: **1,416**; dead_end: **14,916**
- **logs** table deltas:
  - ana: **61**; autoana: **24**; vac: **0**; autovac: **15**; live_end: **5,642,287**; dead_end: **580,283** (large dead‑tuple accumulation from autovacuum‑driven churn)
- **cp_timed per 3‑min window**: all zeros (0 min:0, 3 min:0, 6 min:0, 9 min:0, 12 min:0, 15 min:0)

**Interpretation**: Baseline ran with the original config (15‑min timeout, 2 GB max_wal_size). All checkpoints were WAL‑forced (cp_req 4 across 15.2 min); the checkpointer wrote ~137 k buffers in ~460 s of write time; WAL grew to ~5 GB (wal_bytes 5 102 MB); a noticeable dead‑tuple load built up on both tables (especially logs, 580 k dead). Autoanalyze ran 17 times on log_counts and 24 times on logs via autovacuum, plus the app guard re‑analyzed 61 times per table.

---

**Corresponding optimized‑leg deltas** (for contrast, see `pg-confirm-optimized-counters.log` in this directory):
- cp_timed: 0 → 0 (still no timed checkpoints)
- cp_req: 1 → 22 (rapid WAL‑forced checkpoints every ~40 s at the observed ~336 MB/min WAL rate)
- cp_write_ms: 29 → 675,135 ms (total checkpointer CPU +193%)
- cp_bufs: 923 → 445,578 (total buffers +225%)
- wal_bytes_MB: 6.9 → 5,864.3 MB
- waldir peak MB: 2,147 → 520 MB (4× smaller footprint)
- logs autoanalyze: 24 → **0**; log_counts autoanalyze: 17 → **0**; logs dead tuples: 580,283 → **0** (storm eliminated)
- logs autovacuum: 15 → **3**; log_counts autovacuum: **1**

--- 

*This file is derived from the live‑capture log; see the transcript and `pg-confirm-optimized-counters.log` for the full raw data.*