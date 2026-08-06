import type { Pool } from "pg";
import { buildAggregateQuery, buildLogsQuery, type AggregateParams, type ListFilters, type TenantScope } from "../lib/queryParams.js";
import { encodeCursor, type Cursor } from "../lib/cursor.js";
import type { AttributeValue } from "../lib/validation.js";

/**
 * Persistence layer for queries — HTTP handlers never touch SQL directly.
 * Everything here is parameterized (see lib/queryParams.js for the builder).
 */

export interface LogRow {
  id: string;
  timestamp: string;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, AttributeValue>;
}

export interface LogPage {
  logs: LogRow[];
  /** Opaque base64url cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

export async function queryLogs(
  pool: Pool,
  filters: ListFilters,
  limit: number,
  cursor: Cursor | null,
  tenantId: TenantScope = undefined
): Promise<LogPage> {
  const { sql, params } = buildLogsQuery({ filters, limit, cursor, tenantId });
  const res = await pool.query(sql, params);
  const rows = res.rows as Array<{
    id: string;
    ts: Date;
    level: string;
    service: string;
    message: string;
    attributes: Record<string, AttributeValue>;
  }>;

  // We fetched limit+1 rows: the extra row proves a next page exists.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const logs: LogRow[] = page.map((r) => ({
    id: String(r.id),
    timestamp: r.ts.toISOString(),
    level: r.level,
    service: r.service,
    message: r.message,
    attributes: r.attributes,
  }));

  const last = page[page.length - 1];
  return {
    logs,
    nextCursor: hasMore && last ? encodeCursor(last.ts, String(last.id)) : null,
  };
}

export interface AggregateBucket {
  start: Date;
  group: string | null;
  count: number;
}

export async function aggregateLogs(
  pool: Pool,
  params: AggregateParams,
  tenantId: TenantScope = undefined
): Promise<AggregateBucket[]> {
  const { sql, params: queryParams } = buildAggregateQuery({ ...params, tenantId });
  const res = await pool.query(sql, queryParams);
  return res.rows.map((r) => ({
    start: (r as { bucket_start: Date }).bucket_start,
    group: (r as { group_name: string | null }).group_name,
    count: Number((r as { count: number }).count),
  }));
}
