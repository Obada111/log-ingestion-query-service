import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { loadConfig, type Config } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createWriter, type IngestWriter } from "../../src/services/ingestWriter.js";
import { buildApp } from "../../src/app.js";

/**
 * Integration test helper: builds the real app (real pool, real migrations)
 * against the local PostgreSQL from docker compose, with a clean slate.
 *
 * WHY no test doubles: the contract is about real behavior under real SQL —
 * keyset pagination, GIN containment, date_bin bucketing and chunked deletes
 * are all database behaviors that a mock would silently get wrong.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://loguser:logpass@localhost:5432/logdb";

export interface TestApp {
  app: FastifyInstance;
  pool: Pool;
  writer: IngestWriter;
  config: Config;
  close: () => Promise<void>;
}

export async function setupTestApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const config = loadConfig({
    databaseUrl: TEST_DATABASE_URL,
    ingestMaxFlushWaitMs: 5,
    ...overrides,
  });
  const pool = createPool(config);
  await runMigrations(pool);
  // Clean slate, preserving the sequence for predictable ids.
  await pool.query("TRUNCATE logs, api_keys, log_counts RESTART IDENTITY");

  const writer = createWriter(pool, config);
  const readyState = { ready: true };
  const app = buildApp({
    config,
    pool,
    writer,
    ready: { isReady: () => readyState.ready },
  });
  await app.ready();

  const close = async (): Promise<void> => {
    await app.close();
    await pool.end();
  };
  return { app, pool, writer, config, close };
}

/** Wait until the coalescing writer has drained everything it accepted. */
export async function drainWriter(writer: IngestWriter): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (writer.pendingCount === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("writer did not drain within 2s");
}

export function makeLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2026-07-20T14:32:01.123Z",
    level: "info",
    service: "checkout",
    message: "payment declined",
    attributes: { user_id: "42" },
    ...overrides,
  };
}

export async function ingest(
  app: FastifyInstance,
  logs: Array<Record<string, unknown>>
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/logs",
    payload: { logs },
  });
  if (res.statusCode !== 200) {
    throw new Error(`ingest failed: ${res.statusCode} ${res.body}`);
  }
}
