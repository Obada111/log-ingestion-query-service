import { createHash } from "node:crypto";
import type { Pool } from "pg";

/**
 * API key storage. Keys are stored as SHA-256 hashes so a database leak
 * never exposes plaintext secrets, while lookups stay a trivial indexed
 * equality. Seeding is idempotent (ON CONFLICT DO NOTHING) and runs at
 * startup before /health reports ready.
 */

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export interface ApiKeyInfo {
  scopes: string[];
  tenantId: string | null;
}

export async function seedLoadgenKey(pool: Pool, key: string): Promise<void> {
  await pool.query(
    `INSERT INTO api_keys (key_hash, name, scopes, tenant_id)
     VALUES ($1, 'loadgen', ARRAY['ingest', 'query'], NULL)
     ON CONFLICT (key_hash) DO NOTHING`,
    [hashApiKey(key)]
  );
}

export async function lookupApiKey(pool: Pool, key: string): Promise<ApiKeyInfo | null> {
  const res = await pool.query(
    `SELECT scopes, tenant_id FROM api_keys WHERE key_hash = $1`,
    [hashApiKey(key)]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { scopes: row.scopes, tenantId: row.tenant_id ?? null };
}
