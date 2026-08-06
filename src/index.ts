import { loadConfig } from "./config.js";
import { createPool, createWritePool, waitForDatabase } from "./db/pool.js";
import { runMigrations } from "./db/migrations.js";
import { createWriter } from "./services/ingestWriter.js";
import { startRetentionSweeper } from "./services/retention.js";
import { seedLoadgenKey } from "./auth/keys.js";
import { buildApp } from "./app.js";

/**
 * Bootstrap sequence:
 *   1. connect to PostgreSQL (retry with backoff while the DB container boots)
 *   2. run migrations (advisory-lock guarded)
 *   3. seed the LOADGEN_API_KEY (auth feature; idempotent)
 *   4. start the retention sweeper
 *   5. listen — only then does /health report ready
 *
 * The app is deliberately not listening before migrations finish, so a
 * client polling /health can never observe a half-migrated service.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool(config);
  await waitForDatabase(pool);
  await runMigrations(pool);

  if (config.authEnabled && config.loadgenApiKey) {
    await seedLoadgenKey(pool, config.loadgenApiKey);
    console.log("[auth] seeded load generator key");
  }

  const writer = createWriter(createWritePool(config), config);
  const stopRetention = startRetentionSweeper(pool, config);

  const readyState = { ready: false };
  const app = buildApp({
    config,
    pool,
    writer,
    ready: { isReady: () => readyState.ready },
  });

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    readyState.ready = true;
    console.log(`log-service listening on :${config.port} (auth=${config.authEnabled})`);

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`received ${signal}, shutting down`);
      readyState.ready = false;
      stopRetention();
      try {
        await app.close();
      } finally {
        await pool.end();
        await writer.end();
        process.exit(0);
      }
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (err) {
    console.error("startup failed:", err);
    process.exit(1);
  }
}

void main();
