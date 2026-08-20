# Official Benchmark Baseline

Three identical runs of the official local benchmark on the same repository (`9e42226`, `.gitattributes` pinned LF) and the same machine. No code changes between runs. Purpose: measure machine variance before any further optimization.

## Machine information

- **Host**: Lenovo laptop, Intel Core i7-8750H (6 cores / 12 threads @ 2.20 GHz)
- **OS**: Windows 11 Pro (10.0.26200), win32 platform, PowerShell 5.1
- **Docker backend**: Docker Desktop 29.6.2, WSL2 backend
- **Docker engine resources**: 12 CPUs, 8,259,256,320 bytes (~7.7 GiB) RAM
- **Host RAM**: 15.9 GB total, ~4.1 GB free during this session
- **WSL2 configuration**: no `%UserProfile%\.wslconfig` (defaults). Requirement check (≈3.5 CPUs / 2.25 GB) is satisfied by the Docker VM: CLI engine probe reported `requiredCpus: 5.5, sufficient: true, requiredMemoryBytes: 2415919104 (2.25 GB), memorySufficient: true`. No `.wslconfig` change made.
- **Command (identical each run)**:
  `npx --yes github:Ahmad-Abbas-Foothill/logs-benchmark-cli --compose ./docker-compose.yml --full --seed 6122026 --runner docker --json benchmark-report.json --generator-cpus 4`
- **Resource caps applied**: application 0.5 CPU / 256 MB, postgres 1 CPU / 1024 MB. Generator: k6 0.54.0 in Docker on the `lgbench-*` network, 4 CPUs / 1 GB.
- **Scoring model**: `2026-08-18.v10` (correctness 15, performance 50, queries 15, reliability 20).
- **Records**: `benchmarks/official-baseline-01.json`, `-02.json`, `-03.json`.

## Machine speed line (per run)

- Run 1: **machine speed 0.29x reference** — "much slower than the reference; treat performance points as directional only"
- Run 2: **machine speed 0.27x reference** — same note
- Run 3: **machine speed 0.25x reference** — same note

Monotonic decline (0.29 → 0.27 → 0.25) across the session — host contention/thermal/memory pressure increasing over time (host free RAM was ~4.1 GB by the end).

## Run #1

- Overall score: **76.0 / 100** (75.998)
- Correctness: 15 / 15 (100%)
- Performance: 32.4 / 50 (64.7%) — components: throughput 0.347/0.4, errors 0.3/0.3, latency 0/0.2, sustained bonus 0
- Queries: 8.6 / 15 (57.6%) — aggregate latency 0.294/1.0 → 2.65 pts, consistency 4/4 → 6 pts
- Reliability: 20 / 20 (100%), 4/4 scenarios completed, no crash
- Machine speed: 0.29x
- Throughput (load): 13,014/s (offered 15,000/s)
- Ingestion p95: 1327 ms
- Aggregate p95: 353 ms
- HTTP error rate: 0.0%
- PostgreSQL CPU: not sampled this run
- PostgreSQL memory: not sampled this run
- Application CPU: not sampled this run
- Application memory: not sampled this run
- Read-after-write: 0.8% success
- Drain (accepted → visible): 1,561,700 → 1,561,700 (Δ 0; 30 s bounded window)
- Warnings: k6 could not start 2,382 scheduled iterations in load; 17,449 stress; 5,656 spike; 18,543 breakpoint — generator limited, service not limited (`generatorLimited: true`, `serviceLimited: false`)

## Run #2

- Overall score: **74.8 / 100** (74.793)
- Correctness: 15 / 15
- Performance: 31.1 / 50
- Queries: 8.7 / 15 — aggregate p95 351 ms, consistency 4/4
- Reliability: 20 / 20
- Machine speed: 0.27x
- Throughput (load): 12,083/s (offered 15,000/s)
- Ingestion p95: 1402 ms
- Aggregate p95: 351 ms
- HTTP error rate: 0.0%
- PostgreSQL / app CPU & memory: not sampled this run
- Read-after-write: 1.7% success
- Drain: 1,450,000 → 1,450,000 (Δ 0)
- Warnings: 3,499 dropped in load; 17,926 stress; 5,738 spike; 18,597 breakpoint — generator limited, service not limited

## Run #3

- Overall score: **69.4 / 100** (69.387)
- Correctness: 15 / 15
- Performance: 27.9 / 50
- Queries: 6.5 / 15 — aggregate p95 474 ms, consistency 4/4
- Reliability: 20 / 20
- Machine speed: 0.25x
- Throughput (load): 9,691/s (offered 15,000/s)
- Ingestion p95: 2009 ms
- Aggregate p95: 474 ms
- HTTP error rate: 0.0%
- PostgreSQL CPU: avg 40.3%, max 96.6% (1 CPU cap) — sampled every 5 s during this run
- PostgreSQL memory: avg 538 MiB, max 846 MiB / 1 GiB
- Application CPU: avg 27.7%, max 51.1% (0.5 CPU cap)
- Application memory: avg 58 MiB, max 114 MiB / 256 MiB
- Read-after-write: 0.0% success
- Drain: 1,162,900 → 1,162,900 (Δ 0)
- Warnings: 6,370 dropped in load (worst); 17,645 stress; 6,636 spike; 18,223 breakpoint — generator limited, service not limited

## Averages and variance

| Metric | Run 1 | Run 2 | Run 3 | Avg | Spread |
|---|---|---|---|---|---|
| Overall score | 76.0 | 74.8 | 69.4 | **73.4** | 6.6 (9.0% of mean) |
| Throughput (load) | 13,014/s | 12,083/s | 9,691/s | 11,596/s | 3,323/s |
| Ingestion p95 | 1327 ms | 1402 ms | 2009 ms | 1580 ms | 682 ms |
| Aggregate p95 | 353 ms | 351 ms | 474 ms | 393 ms | 123 ms |
| Correctness | 15/15 | 15/15 | 15/15 | 15/15 | 0 |
| Reliability | 20/20 | 20/20 | 20/20 | 20/20 | 0 |
| HTTP errors | 0% | 0% | 0% | 0% | 0 |
| Machine speed | 0.29x | 0.27x | 0.25x | 0.27x | 0.04 |

## Warnings

Every scenario in every run printed the k6 dropped-iteration warning ("The generator, not your service, was the constraint, so this understates you"), and every run printed the "much slower than the reference" machine-speed note. The host's free RAM (~4.1 GB) and an open IDE/browsers/Discord create memory pressure on the 7.7 GiB WSL2 VM; this is the dominant, monotonic noise source across the three runs.

## Interpretation

- **Correctness 15/15 and reliability 20/20 are stable across all runs** — these categories transfer to the graded machine exactly.
- Performance and Queries are machine-bound here: PostgreSQL hit 96.6% CPU at load while the k6 generator simultaneously starved (2,382–6,370 dropped iterations in load alone), so load throughput and p95 are capped by the host, not the service. Scores are directional on this machine.
- **Baseline status: NOT stable enough for point-level comparisons on this host.** Identical code produced 69.4–76.0 across three back-to-back runs (6.6-point spread vs a ~1.5-point measurement noise floor on a healthy engine, seen earlier in this project at 86.9 vs 89.86). Only large deltas — several points — should be treated as real on this machine, and any A/B must pair the experiment against a fresh baseline run with a matching machine-speed factor.
- For future A/Bs: restart Docker Desktop before each run, close memory-heavy apps, and compare an experiment only against a same-session baseline run (not against these numbers).

## Baseline status

Machine is NOT sufficiently stable for fine-grained score comparisons today (host memory pressure spoils run-to-run comparability). It IS stable for verifying correctness/reliability (perfect on all runs) and for catching large regressions/improvements (> ~5 points). Historical best on this machine remains 89.86/100 from a fresh-engine session on the same commit stack; that number is not comparable to today's degraded session and must not be used as a paired baseline.