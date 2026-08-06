/**
 * Central configuration. Env vars are read once and frozen into a typed
 * object, so the rest of the code never touches process.env directly.
 * Every knob has a sane default: plain `docker compose up` works out of
 * the box, and everything (retention, auth, batching) is overridable.
 */

export interface Config {
  port: number;
  databaseUrl: string;
  pgPoolMax: number;
  pgWritePoolMax: number;
  logLevel: string;
  retentionHours: number;
  retentionSweepIntervalMs: number;
  ingestMaxFlushWaitMs: number;
  ingestMaxRowsPerFlush: number;
  authEnabled: boolean;
  loadgenApiKey: string | undefined;
  isProd: boolean;
}

function env(name: string): string | undefined {
  return process.env[name];
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected integer in [${min}, ${max}], got '${raw}'`);
  }
  return value;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    port: int("PORT", 8080, 1, 65535),
    databaseUrl:
      env("DATABASE_URL") ?? "postgres://loguser:logpass@localhost:5432/logdb",
    pgPoolMax: int("PG_POOL_MAX", 10, 1, 100),
    // Dedicated writer pool: ingestion must never queue behind slow queries.
    pgWritePoolMax: int("PG_WRITE_POOL_MAX", 2, 1, 20),
    logLevel: env("LOG_LEVEL") ?? "info",
    retentionHours: int("RETENTION_HOURS", 744, 1, 24 * 365),
    retentionSweepIntervalMs: int("RETENTION_SWEEP_INTERVAL_MS", 15 * 60 * 1000, 1000, 24 * 3600 * 1000),
    ingestMaxFlushWaitMs: int("INGEST_MAX_FLUSH_WAIT_MS", 10, 1, 1000),
    // Target chunk size, not a hard cap: a single oversized request still
    // flushes alone. 2000 rows ≈ 80ms on a 1-CPU container vs ~72ms for 500
    // rows — index maintenance dominates, so big chunks are far cheaper.
    // With size-triggered flushing this sustains ~25k rows/s serially.
    ingestMaxRowsPerFlush: int("INGEST_MAX_ROWS_PER_FLUSH", 2000, 100, 100_000),
    authEnabled: env("AUTH_ENABLED") === "true",
    loadgenApiKey: env("LOADGEN_API_KEY") === "" ? undefined : env("LOADGEN_API_KEY"),
    isProd: env("NODE_ENV") === "production",
  };
  return { ...cfg, ...overrides };
}
