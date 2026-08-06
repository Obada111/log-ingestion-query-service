import type { Pool } from "pg";
import type { Config } from "../config.js";

/**
 * Retention sweeper — deletes logs older than the configured horizon.
 *
 * Deletes run in bounded chunks with a short pause between them, so a sweep
 * never blocks concurrent ingestion/queries with a giant transaction or
 * dead-tuple bloat. Chunked deletes are the right fit at this project's
 * scale; at production scale the canonical answer is time-based table
 * partitioning + DROP PARTITION (see study/10-retention.md).
 */

const CHUNK_SIZE = 10_000;
const CHUNK_PAUSE_MS = 20;

export async function sweepExpired(
  pool: Pool,
  retentionHours: number,
  chunkSize = CHUNK_SIZE
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionHours * 3_600_000);
  let total = 0;

  for (;;) {
    // ctid IN (SELECT ctid ... LIMIT n): cheap, bounded work per statement.
    const res = await pool.query(
      `DELETE FROM logs
        WHERE ctid IN (SELECT ctid FROM logs WHERE ts < $1 LIMIT $2)`,
      [cutoff, chunkSize]
    );
    const deleted = res.rowCount ?? 0;
    if (deleted === 0) break;
    total += deleted;
    if (deleted === chunkSize) {
      // More may remain — yield to other work before the next chunk.
      await new Promise((r) => setTimeout(r, CHUNK_PAUSE_MS));
    }
  }
  return total;
}

/**
 * Start the periodic sweeper. Returns a stop function. Uses a reentrancy
 * guard so overlapping sweeps can never pile up (slow DB + fast interval
 * would otherwise stack DELETE storms on top of each other).
 */
export function startRetentionSweeper(
  pool: Pool,
  config: Config,
  onError: (err: Error) => void = (err) => console.error("[retention]", err.message)
): () => void {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const deleted = await sweepExpired(pool, config.retentionHours);
      if (deleted > 0) console.log(`[retention] deleted ${deleted} expired logs`);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.retentionSweepIntervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
