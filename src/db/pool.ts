import pg from "pg";
import type { Config } from "../config.js";

/**
 * Connection pools. pg.Pool keeps a fixed set of prepared clients, keeping
 * connection setup out of the hot path. Reads and writes use separate pools
 * so that slow queries can never starve the ingestion writer: it always has
 * its own connections (2) while the read pool (10) is sized to PostgreSQL's
 * single CPU — more clients than CPUs only adds queueing.
 */
export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "log-service",
    // Guarantee bucket alignment: date_bin/date_trunc of timestamptz are
    // timezone-independent, but we normalize the session anyway to avoid any
    // surprise in ::text casts of timestamps.
    options: "-c timezone=UTC",
  });

  // Fail fast on wrong credentials instead of masking it as a slow query.
  pool.on("error", (err) => {
    console.error("[pool] idle client error:", err.message);
  });

  return pool;
}

/** Dedicated small pool for the ingestion writer, so queries can never starve it. */
export function createWritePool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgWritePoolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "log-service-writer",
    options: "-c timezone=UTC",
  });
  pool.on("error", (err) => {
    console.error("[write-pool] idle client error:", err.message);
  });
  return pool;
}

/** Wait until the database answers, retrying with backoff (startup resilience). */
export async function waitForDatabase(pool: pg.Pool, attempts = 60): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === attempts) throw new Error(`database unreachable after ${attempts} attempts: ${msg}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * i, 5_000)));
    }
  }
}
