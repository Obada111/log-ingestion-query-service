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
  // Fresh stats at boot so the planner picks index plans while the harness
  // ramps on an empty table (autovacuum only catches up after ~10k+ rows).
  // Boot-time only; ANALYZE is not on the request path.
  await pool.query("ANALYZE logs").catch(() => {});
  await pool.query("ANALYZE log_counts").catch(() => {});

  if (config.authEnabled && config.loadgenApiKey) {
    await seedLoadgenKey(pool, config.loadgenApiKey);
    console.log("[auth] seeded load generator key");
  }

  const writer = createWriter(createWritePool(config), config);
  const stopRetention = startRetentionSweeper(pool, config);

  // Planner-stats guard. On a busy 1-CPU database autovacuum analysis can
  // lag for tens of seconds; with stale "empty table" stats PostgreSQL
  // switches the list queries to sequential scans (measured: 1.6ms -> up to
  // 550ms per query under load). Cheap conditional: re-analyze only when the
  // last analyze is older than a few seconds.
  const statsGuard = setInterval(() => {
    void (async () => {
      try {
        const res = await pool.query(
          "SELECT max(last_analyze) AS last FROM pg_stat_user_tables WHERE relname IN ('logs', 'log_counts')"
        );
        const last = res.rows[0]?.last;
        const lastMs = last ? new Date(last as string).getTime() : 0;
        if (Date.now() - lastMs > 10_000) {
          await pool.query("ANALYZE logs");
          await pool.query("ANALYZE log_counts");
        }
      } catch {
        // Best-effort; autovacuum remains the fallback.
      }
    })();
  }, 5_000);
  statsGuard.unref?.();

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
      clearInterval(statsGuard);
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
