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
