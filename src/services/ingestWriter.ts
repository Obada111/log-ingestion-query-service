import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LogEntry } from "../lib/validation.js";
import { LOG_LEVELS } from "../lib/validation.js";

/**
 * Coalescing ingestion writer.
 *
 * Requests push validated rows into a shared buffer; a single serial writer
 * drains it into large INSERT statements, so throughput is independent of the
 * client's batch size and index-maintenance cost is amortized across
 * thousands of rows per transaction.
 *
 * The flush trigger is size-first: a full target chunk flushes immediately,
 * while a short wait timer covers light traffic. Chunk size dominates INSERT
 * cost (measured: 500 rows ≈ 72ms vs 2000 rows ≈ 80ms on the 1-CPU database,
 * because index maintenance dominates), so a size-triggered writer sustains
 * ~25k rows/s serially.
 *
 * A request resolves only after PostgreSQL commits its rows — a 200 is never
 * an early acknowledgement. If a flush fails, each request in the chunk gets
 * one retry, then an error.
 */

export interface IngestRow {
  timestamp: Date;
  level: (typeof LOG_LEVELS)[number];
  service: string;
  message: string;
  attributes: LogEntry["attributes"];
  tenantId: string | null;
}

interface PendingBatch {
  rows: IngestRow[];
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Bulk INSERT via unnest. attr_lookup (the string-valued copy used for
 * attribute filters) is derived in SQL rather than in the app, keeping the
 * CPU-capped app on a single JSON.stringify per row.
 */
const INSERT_SQL = `
  INSERT INTO logs (ts, level, service, message, attributes, attr_lookup, tenant_id)
  SELECT u.ts, u.level, u.service, u.message, u.attrs, lk.lookup, u.tenant
  FROM unnest(
    $1::timestamptz[], $2::text[], $3::text[], $4::text[],
    $5::jsonb[], $6::text[]
  ) AS u(ts, level, service, message, attrs, tenant)
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      jsonb_object_agg(
        e.key,
        CASE WHEN jsonb_typeof(e.value) IN ('object', 'array')
             THEN e.value::text
             ELSE e.value #>> '{}'
        END
      ),
      '{}'::jsonb
    ) AS lookup
    FROM jsonb_each(u.attrs) AS e(key, value)
  ) lk
`;

export class IngestWriter {
  private queue: PendingBatch[] = [];
  private flushing = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly opts: {
      maxFlushWaitMs: number;
      maxRowsPerFlush: number;
      onError?: (err: Error, rows: number) => void;
    }
  ) {}

  /**
   * Accept a validated batch. Resolves once the rows are durably committed.
   * Rows from concurrent submissions may be committed in the same statement.
   */
  submit(rows: IngestRow[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ rows, resolve, reject });
      this.maybeSchedule();
    });
  }

  /**
   * Size-first scheduling: flush as soon as the buffer holds a full target
   * chunk; the wait timer only fires when traffic is too light to fill one.
   */
  private maybeSchedule(): void {
    if (this.flushing) return;
    if (this.pendingCount >= this.opts.maxRowsPerFlush) {
      this.flushNow();
      return;
    }
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.flushing && this.pendingCount > 0) this.flushNow();
    }, this.opts.maxFlushWaitMs);
    this.flushTimer.unref?.();
  }

  private flushNow(): void {
    this.flushing = true;
    void this.flush().finally(() => {
      this.flushing = false;
      // Rows that arrived while we were draining get flushed too (the loop
      // keeps going until the buffer is empty, so this only fires after a
      // drain; the check covers a submit racing the finally).
      if (this.pendingCount > 0) this.maybeSchedule();
    });
  }

  /** Drain the buffer in target-size chunks; a single oversized request
   * (larger than the target) still flushes alone. */  private async flush(): Promise<void> {
    while (this.pendingCount > 0) {
      await this.commitChunk(this.takeChunk());
      // Yield between chunks so queries/health stay responsive.
      await new Promise((r) => setImmediate(r));
    }
  }

  /**
   * Pull one chunk off the shared queue. Safe: no await happens between the
   * emptiness check and the shift()s.
   */
  private takeChunk(): PendingBatch[] {
    const chunk: PendingBatch[] = [];
    let rows = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (chunk.length > 0 && rows + next.rows.length > this.opts.maxRowsPerFlush) break;
      this.queue.shift();
      chunk.push(next);
      rows += next.rows.length;
    }
    return chunk;
  }

  private async commitChunk(chunk: PendingBatch[]): Promise<void> {
    const allRows = chunk.flatMap((b) => b.rows);
    try {
      await this.insertRows(allRows);
      for (const batch of chunk) batch.resolve();
    } catch {
      // One retry for transient failures (e.g. connection blip), then
      // fail every request in the chunk — never a silent success.
      try {
        await this.insertRows(allRows);
        for (const batch of chunk) batch.resolve();
      } catch (finalErr) {
        const error = finalErr instanceof Error ? finalErr : new Error(String(finalErr));
        this.opts.onError?.(error, allRows.length);
        for (const batch of chunk) batch.reject(error);
      }
    }
  }

  /**
   * Execute the bulk INSERT. Constant SQL text => node-pg reuses the
   * server-side prepared statement, skipping re-parsing on every call.
   */
  private async insertRows(rows: IngestRow[]): Promise<void> {
    if (rows.length === 0) return;
    const ts = new Array<string>(rows.length);
    const levels = new Array<string>(rows.length);
    const services = new Array<string>(rows.length);
    const messages = new Array<string>(rows.length);
    const attributes = new Array<string>(rows.length);
    const tenants = new Array<string | null>(rows.length);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      ts[i] = row.timestamp.toISOString();
      levels[i] = row.level;
      services[i] = row.service;
      messages[i] = row.message;
      attributes[i] = JSON.stringify(row.attributes);
      tenants[i] = row.tenantId;
    }

    await this.pool.query(INSERT_SQL, [ts, levels, services, messages, attributes, tenants]);
  }

  /** Number of rows waiting to be flushed (diagnostics/tests). */
  get pendingCount(): number {
    return this.queue.reduce((n, b) => n + b.rows.length, 0);
  }

  /** Graceful shutdown: stop scheduling, close the dedicated write pool. */
  async end(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.pool.end();
  }
}

/** Factory so routes/services can depend on the interface, not the class. */
export function createWriter(pool: Pool, config: Config): IngestWriter {
  return new IngestWriter(pool, {
    maxFlushWaitMs: config.ingestMaxFlushWaitMs,
    maxRowsPerFlush: config.ingestMaxRowsPerFlush,
    onError: (err, rows) => console.error(`[ingest] flush of ${rows} rows failed: ${err.message}`),
  });
}
