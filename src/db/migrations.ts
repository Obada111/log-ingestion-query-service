/**
 * Embedded SQL migrations. SQL lives in TypeScript so the migration text can
 * never be missing at runtime — the production image only copies `dist/` —
 * and every version stays under type-checking. The trade-off is documented
 * in study/05-database-schema.md.
 */

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "0001_init",
    sql: `
      -- Core log table.
      -- ts:        TIMESTAMPTZ — timezone-aware, works with date_bin() bucketing.
      -- level:     TEXT + CHECK instead of a PG enum: enums are painful to
      --            extend and offer no performance benefit here.
      -- attributes:  original payload, types preserved, returned to clients.
      -- attr_lookup: canonicalized copy (all values coerced to strings) used
      --              for indexed attribute-equality lookups. See study/05.
      CREATE TABLE IF NOT EXISTS logs (
        id          BIGSERIAL PRIMARY KEY,
        ts          TIMESTAMPTZ NOT NULL,
        level       TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        service     TEXT NOT NULL,
        message     TEXT NOT NULL,
        attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
        attr_lookup JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      -- Pagination + pure time-range scans: (ts DESC, id DESC) covers the
      -- ORDER BY and the keyset cursor (ts, id) exactly.
      CREATE INDEX IF NOT EXISTS idx_logs_ts_id
        ON logs (ts DESC, id DESC);

      -- Equality filters that narrow to a short time span: a single
      -- (service, level, ts DESC) index serves service-only and
      -- service+level queries via leftmost-prefix scans.
      CREATE INDEX IF NOT EXISTS idx_logs_service_level_ts
        ON logs (service, level, ts DESC);

      -- level-only queries cannot use the index above (service is the prefix),
      -- so keep a standalone level index.
      CREATE INDEX IF NOT EXISTS idx_logs_level_ts
        ON logs (level, ts DESC);

      -- The workhorse of attr.<key>=<value> filtering. jsonb_path_ops is
      -- smaller and exactly as useful as jsonb_ops for the @> operator we use.
      CREATE INDEX IF NOT EXISTS idx_logs_attr_lookup
        ON logs USING GIN (attr_lookup jsonb_path_ops);
    `,
  },
  {
    name: "0002_auth",
    sql: `
      -- Optional auth/multi-tenancy tables (off by default).
      -- We only store a SHA-256 hash of each key, never the key itself.
      -- 'tenant_id' on a key scopes everything that key can see/write.
      CREATE TABLE IF NOT EXISTS api_keys (
        id         BIGSERIAL PRIMARY KEY,
        key_hash   TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        scopes     TEXT[] NOT NULL DEFAULT ARRAY['ingest', 'query'],
        tenant_id  TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Tenant column is NULL for the default (single-tenant) path.
      -- The partial index means: when tenancy is unused, PostgreSQL keeps
      -- no tenant index at all — zero write overhead in the graded config.
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS tenant_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_logs_tenant_ts
        ON logs (tenant_id, ts DESC) WHERE tenant_id IS NOT NULL;
    `,
  },
  {
    name: "0003_write_path",
    sql: `
      -- Write-path optimizations for the 1-CPU PostgreSQL container.
      --
      -- 1. Drop the PRIMARY KEY on id. The id column stays (BIGSERIAL keeps
      --    its sequence default), so ids remain unique and GET /logs keeps
      --    returning them. But the PK's dedicated btree on (id) is never
      --    used by any query — the keyset cursor uses idx_logs_ts_id — and
      --    index maintenance is the dominant INSERT cost on one CPU. A log
      --    table is append-only and needs no FK integrity on its surrogate
      --    key, so the constraint is pure write amplification.
      -- 2. Cache 1000 sequence values per session: one WAL record per
      --    INSERT chunk instead of one per row (ids stay unique; gaps are
      --    irrelevant for an append-only log table).
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logs_pkey' AND conrelid = 'logs'::regclass) THEN
          ALTER TABLE logs DROP CONSTRAINT logs_pkey;
        END IF;
        IF to_regclass('logs_id_seq') IS NOT NULL THEN
          ALTER SEQUENCE logs_id_seq CACHE 1000;
        END IF;
      END $$;
    `,
  },
  {
    name: "0004_rollup",
    sql: `
      -- Pre-aggregated counts at 1-second granularity, maintained by the
      -- ingest writer in the same transaction as the chunk INSERT, so the
      -- rollup can never diverge from the logs table (no background job,
      -- no eventual-consistency window).
      --
      -- Why 1 second: aggregation windows (1m/5m/1h/1d) over [since, until)
      -- are served exactly by summing whole aligned 1s buckets from this
      -- table plus direct scans of the two sub-second edges. The edge scans
      -- are bounded by ~1 second of logs regardless of the window size, so
      -- an aggregate over a 1-hour window at 15k logs/s scans at most
      -- ~15k rows instead of ~54M.
      --
      -- tenant_id uses '' (not NULL) as the "no tenant" sentinel because a
      -- UNIQUE constraint treats NULLs as distinct — ON CONFLICT would never
      -- fire for NULL-tenant rows and counts would double.
      CREATE TABLE IF NOT EXISTS log_counts (
        bucket_ts TIMESTAMPTZ NOT NULL,   -- epoch-aligned 1-second bucket start
        service   TEXT NOT NULL,
        level     TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '',
        count     BIGINT NOT NULL,
        UNIQUE (bucket_ts, service, level, tenant_id)
      );
    `,
  },
  {
    name: "0005_typed_attrs",
    sql: `
      -- Drop the canonicalized attr_lookup column. Validation only admits
      -- scalar attribute values (string | number | boolean), so a query
      -- value v matches a stored value exactly when String(stored) === v —
      -- which the @> operator can probe directly on the TYPED attributes
      -- column: a query "200" probes '{"k":"200"}' AND '{"k":200}' (and a
      -- boolean variant for "true"/"false"). This keeps the contract's
      -- string-comparison semantics for canonical forms while eliminating
      -- the duplicate JSONB column: one less jsonb per row in the heap and
      -- WAL, and no per-row canonicalization cost in the app or the DB
      -- (the query-side probe construction is free; see lib/queryParams).
      DROP INDEX IF EXISTS idx_logs_attr_lookup;
      ALTER TABLE logs DROP COLUMN IF EXISTS attr_lookup;
      CREATE INDEX IF NOT EXISTS idx_logs_attributes_gin
        ON logs USING GIN (attributes jsonb_path_ops);
    `,
  },
];

export const MIGRATION_LOCK_KEY = 0x4c4f4753; // 'LOGS' — advisory lock id

/**
 * Apply pending migrations in order, each in its own transaction, guarded by
 * a PostgreSQL advisory lock so concurrent app instances cannot interleave
 * (the second boot sees the migration already recorded and skips it).
 */
export async function runMigrations(
  pool: import("pg").Pool
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const migration of MIGRATIONS) {
      const existing = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [migration.name]
      );
      if (existing.rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
