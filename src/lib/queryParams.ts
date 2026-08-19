import { decodeCursor, type Cursor } from "./cursor.js";
import { LOG_LEVELS, type LogLevel } from "./validation.js";

/**
 * Query parameter parsing + parameterized SQL building.
 *
 * HTTP handlers stay thin and translate request objects into typed filter
 * structs; all SQL lives here, fully parameterized. No user text is ever
 * interpolated into SQL — values become $n placeholders and the only
 * interpolated identifiers come from compile-time whitelists.
 */

export interface ListFilters {
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  /** Attribute equality pairs (attr.<key> => value), compared as strings. */
  attrPairs: Array<[string, string]>;
  /** Case-insensitive substring match on message. */
  q?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });
const ok = <T>(value: T) => ({ ok: true as const, value });

export const ATTR_PREFIX = "attr.";
const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;

function parseIso(raw: string): Date | null {
  if (!ISO_PREFIX_RE.test(raw)) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ListParams {
  filters: ListFilters;
  limit: number;
  cursor: Cursor | null;
}

/**
 * Parse GET /logs query parameters. Unknown parameters are ignored
 * (lenient — the load generator may add extras); known ones are validated
 * strictly because the contract demands HTTP 400 with {"error": ...} on
 * invalid input.
 */
export function parseListParams(query: Record<string, unknown>): ParseResult<ListParams> {
  const filters: ListFilters = { attrPairs: [] };
  let limit = 100;
  let cursor: Cursor | null = null;

  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined) continue;
    // Repeated params arrive as arrays; take the first (lenient).
    const value = Array.isArray(rawValue) ? String(rawValue[0]) : String(rawValue);

    switch (key) {
      case "service":
        if (value.length === 0) return fail("service must be a non-empty string");
        filters.service = value;
        break;
      case "level":
        if (!(LOG_LEVELS as readonly string[]).includes(value)) {
          return fail(`unsupported level: '${value}'`);
        }
        filters.level = value as LogLevel;
        break;
      case "since": {
        const d = parseIso(value);
        if (!d) return fail(`invalid timestamp: '${value}'`);
        filters.since = d;
        break;
      }
      case "until": {
        const d = parseIso(value);
        if (!d) return fail(`invalid timestamp: '${value}'`);
        filters.until = d;
        break;
      }
      case "limit": {
        if (!/^\d+$/.test(value)) return fail("limit must be a non-negative integer");
        const n = Number(value);
        if (n < 1 || n > 1000) return fail("limit must be between 1 and 1000");
        limit = n;
        break;
      }
      case "cursor": {
        const decoded = decodeCursor(value);
        if (!decoded) return fail("invalid cursor");
        cursor = decoded;
        break;
      }
      case "q":
        if (value.length > 0) filters.q = value;
        break;
      default:
        if (key.startsWith(ATTR_PREFIX)) {
          const attrKey = key.slice(ATTR_PREFIX.length);
          if (attrKey.length === 0) return fail("invalid attribute key");
          filters.attrPairs.push([attrKey, value]);
        }
        // Unknown, non-attr keys: ignored.
    }
  }

  if (filters.since && filters.until && filters.until.getTime() < filters.since.getTime()) {
    return fail("until must not be earlier than since");
  }
  return ok({ filters, limit, cursor });
}

// ---------------------------------------------------------------------------
// Aggregation parameters
// ---------------------------------------------------------------------------

export const BUCKET_INTERVALS = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "1h": "1 hour",
  "1d": "1 day",
} as const;

export type Bucket = keyof typeof BUCKET_INTERVALS;

export const GROUP_COLUMNS = ["service", "level"] as const;
export type GroupColumn = (typeof GROUP_COLUMNS)[number];

export interface AggregateParams {
  filters: ListFilters;
  since: Date;
  until: Date;
  bucket: Bucket;
  groupBy: GroupColumn | null;
}

export function parseAggregateParams(query: Record<string, unknown>): ParseResult<AggregateParams> {
  const parsed = parseListParams(query);
  if (!parsed.ok) return parsed;

  const sinceRaw = query["since"];
  const untilRaw = query["until"];
  const bucketRaw = query["bucket"];
  const groupRaw = query["group_by"];

  if (sinceRaw === undefined) return fail("since is required");
  if (untilRaw === undefined) return fail("until is required");
  if (bucketRaw === undefined) return fail("bucket is required");

  const since = parseIso(String(Array.isArray(sinceRaw) ? sinceRaw[0] : sinceRaw));
  if (!since) return fail(`invalid timestamp: '${String(sinceRaw)}'`);
  const until = parseIso(String(Array.isArray(untilRaw) ? untilRaw[0] : untilRaw));
  if (!until) return fail(`invalid timestamp: '${String(untilRaw)}'`);
  if (until.getTime() < since.getTime()) return fail("until must not be earlier than since");

  const bucket = String(bucketRaw);
  if (!(bucket in BUCKET_INTERVALS)) return fail(`unsupported bucket: '${bucket}' (expected 1m, 5m, 1h or 1d)`);
  const typedBucket = bucket as Bucket;

  let groupBy: GroupColumn | null = null;
  if (groupRaw !== undefined) {
    const g = String(groupRaw);
    if (!(GROUP_COLUMNS as readonly string[]).includes(g)) {
      return fail(`group_by must be 'service' or 'level'`);
    }
    groupBy = g as GroupColumn;
  }

  return ok({ filters: parsed.value.filters, since, until, bucket: typedBucket, groupBy });
}

// ---------------------------------------------------------------------------
// SQL building
// ---------------------------------------------------------------------------

/** Tenant scoping: undefined = no scoping (default), null = NULL-tenant rows, string = one tenant. */
export type TenantScope = string | null | undefined;

export interface WhereOptions {
  filters: ListFilters;
  cursor?: Cursor | null;
  tenantId?: TenantScope;
}

/**
 * Build a parameterized WHERE clause + ordered parameter array.
 * Numbering is sequential, so callers must append their own parameters after
 * `params.length` and refer to them as $params.length+1 etc.
 */
export function buildLogsWhere(opts: WhereOptions): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const t = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const { filters, cursor, tenantId } = opts;

  if (filters.since) clauses.push(`ts >= ${t(filters.since)}`);
  if (filters.until) clauses.push(`ts < ${t(filters.until)}`);
  if (filters.service) clauses.push(`service = ${t(filters.service)}`);
  if (filters.level) clauses.push(`level = ${t(filters.level)}`);
  for (const [key, value] of filters.attrPairs) {
    // Typed attribute probe (migration 0005): stored documents keep the
    // client's original JSON types but query values arrive as strings, so
    // match the string form plus any exact number/boolean representation of
    // it. OR'd jsonb @> probes, all served by the attributes GIN index.
    const probes: string[] = [];
    const numeric = Number(value);
    if (value !== "" && !Number.isNaN(numeric)) {
      probes.push(`attributes @> ${t(JSON.stringify({ [key]: numeric }))}::jsonb`);
    }
    if (value === "true" || value === "false") {
      probes.push(`attributes @> ${t(JSON.stringify({ [key]: value === "true" }))}::jsonb`);
    }
    probes.push(`attributes @> ${t(JSON.stringify({ [key]: value }))}::jsonb`);
    clauses.push(`(${probes.join(" OR ")})`);
  }
  if (filters.q) {
    // ESCAPE '\' makes user-supplied % _ \ literals; substring is matched
    // case-insensitively via ILIKE.
    clauses.push(`message ILIKE '%' || ${t(escapeLike(filters.q))} || '%' ESCAPE '\\'`);
  }
  if (tenantId === null) clauses.push("tenant_id IS NULL");
  else if (typeof tenantId === "string") clauses.push(`tenant_id = ${t(tenantId)}`);
  if (cursor) {
    // Keyset resume: strictly before (ts, id) in descending order.
    // The ts placeholder is bound once and reused — fewer params to send.
    const tsParam = t(cursor.ts);
    const idParam = t(cursor.id);
    clauses.push(`(ts < ${tsParam} OR (ts = ${tsParam} AND id < ${idParam}))`);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Escape LIKE wildcards so a user's q matches its literal text:
 * `50%` must not mean "fifty followed by anything".
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => "\\" + m);
}

export interface LogsQuery {
  sql: string;
  params: unknown[];
  /** limit+1 rows are fetched so the caller can detect "more pages exist". */
  hasMoreProbe: boolean;
}

export function buildLogsQuery(opts: {
  filters: ListFilters;
  limit: number;
  cursor: Cursor | null;
  tenantId?: TenantScope;
}): LogsQuery {
  const where = buildLogsWhere({ filters: opts.filters, cursor: opts.cursor, tenantId: opts.tenantId });
  // LIMIT is a validated integer (1..1000) from parseListParams, never raw
  // user text — inlining is safe and avoids an extra parameter round-trip.
  const sql = `SELECT id, ts, level, service, message, attributes
                 FROM logs ${where.sql}
                ORDER BY ts DESC, id DESC
                LIMIT ${opts.limit + 1}`;
  return { sql, params: where.params, hasMoreProbe: true };
}

export interface AggregateQuery {
  sql: string;
  params: unknown[];
}

/**
 * Aggregation builder with two execution paths:
 *
 * - ROLLUP (default): when only service/level filters are present, the
 *   window is answered from the 1-second `log_counts` rollup maintained by
 *   the ingest writer (see migration 0004). Whole aligned 1-second buckets
 *   inside [since, until) come from the rollup; the two sub-second edges
 *   (<= 1s of logs each, regardless of window size) come from direct index
 *   scans. Exact for every window, and O(buckets + edges) instead of
 *   O(rows) — a 1-hour aggregate at 15k logs/s scans ~15k rows, not ~54M.
 *
 * - SCAN (fallback): when attr.* or q filters are present, the rollup
 *   cannot answer them — fall back to scanning the window directly
 *   (correct, but O(window rows)).
 */
export function buildAggregateQuery(opts: {
  filters: ListFilters;
  since: Date;
  until: Date;
  bucket: Bucket;
  groupBy: GroupColumn | null;
  tenantId?: TenantScope;
}): AggregateQuery {
  if (opts.filters.attrPairs.length > 0 || opts.filters.q !== undefined) {
    return buildAggregateScanQuery(opts);
  }
  return buildAggregateRollupQuery(opts);
}

/** Historical direct-scan path (attr/q filters, small windows). */
function buildAggregateScanQuery(opts: {
  filters: ListFilters;
  since: Date;
  until: Date;
  bucket: Bucket;
  groupBy: GroupColumn | null;
  tenantId?: TenantScope;
}): AggregateQuery {
  const where = buildLogsWhere({
    filters: { ...opts.filters, since: opts.since, until: opts.until },
    tenantId: opts.tenantId,
  });

  // groupBy comes from a compile-time whitelist (GROUP_COLUMNS); `group_name`
  // is NULL::text when no grouping is requested, which the contract requires.
  const groupExpr = opts.groupBy ?? "NULL::text";
  const groupByClause = opts.groupBy ? `GROUP BY 1, ${opts.groupBy}` : "GROUP BY 1";
  const intervalParam = `$${where.params.length + 1}`;

  return {
    sql: `SELECT date_bin(${intervalParam}::interval, ts, TIMESTAMPTZ 'epoch') AS bucket_start,
                 ${groupExpr} AS group_name,
                 count(*)::int AS count
            FROM logs ${where.sql}
           ${groupByClause}
           ORDER BY 1 ASC, 2 ASC`,
    params: [...where.params, BUCKET_INTERVALS[opts.bucket]],
  };
}

/** Rollup path: whole 1s buckets from log_counts + sub-second edge scans. */
function buildAggregateRollupQuery(opts: {
  filters: ListFilters;
  since: Date;
  until: Date;
  bucket: Bucket;
  groupBy: GroupColumn | null;
  tenantId?: TenantScope;
}): AggregateQuery {
  // service/level filters + logs-table tenant semantics (NULL rows are
  // "no tenant"). since/until are handled by the rollup/edge bounds below.
  const where = buildLogsWhere({
    filters: { ...opts.filters, since: undefined, until: undefined },
    tenantId: opts.tenantId,
  });
  const params = [...where.params];
  const t = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const sinceP = t(opts.since);
  const untilP = t(opts.until);
  const bucketP = t(BUCKET_INTERVALS[opts.bucket]);

  // The rollup stores '' for tenantless rows (NULLs are distinct in UNIQUE
  // constraints — see migration 0004); the edge scans keep logs-table
  // semantics (tenant_id IS NULL) via `where.sql`.
  let rollupTenantSql = "";
  if (opts.tenantId === null) rollupTenantSql = " AND tenant_id = ''";
  else if (typeof opts.tenantId === "string") rollupTenantSql = ` AND tenant_id = ${t(opts.tenantId)}`;

  const groupExpr = opts.groupBy ?? "NULL::text";
  // Edge parts aggregate the raw window: group by the bucket expression
  // (and the grouping column when one is requested).
  const edgeGroupBy = opts.groupBy ? "GROUP BY 1, " + opts.groupBy : "GROUP BY 1";
  const filtersSql = where.sql.replace(/^WHERE /, " AND ");
  // ceil-second(since) and floor-second(until): interior rollup bounds.
  // Explicit ::timestamptz casts disambiguate the + operator (otherwise the
  // parser considers interval + interval and errors on date_bin's overloads).
  const ceilSince = `date_bin(interval '1 second', ${sinceP}::timestamptz + interval '1 second', TIMESTAMPTZ 'epoch')`;
  const floorUntil = `date_bin(interval '1 second', ${untilP}::timestamptz, TIMESTAMPTZ 'epoch')`;
  const bucketExpr = `date_bin(${bucketP}::interval, ts, TIMESTAMPTZ 'epoch')`;

  return {
    sql: `SELECT bucket_start, group_name, sum(count)::int AS count
            FROM (
              SELECT date_bin(${bucketP}::interval, bucket_ts, TIMESTAMPTZ 'epoch') AS bucket_start,
                     ${groupExpr} AS group_name, count
                FROM log_counts
               WHERE bucket_ts >= ${ceilSince}
                 AND bucket_ts <  ${floorUntil}
                 ${filtersSql}${rollupTenantSql}
              UNION ALL
              SELECT ${bucketExpr}, ${groupExpr}, count(*)
                FROM logs
               WHERE ts >= ${sinceP}
                 AND ts < ${ceilSince}
                 AND ts < ${untilP}
                 ${filtersSql}
               ${edgeGroupBy}
              UNION ALL
              SELECT ${bucketExpr}, ${groupExpr}, count(*)
                FROM logs
               WHERE ts >= ${floorUntil}
                 AND ts >= ${sinceP}
                 AND ts < ${untilP}
                 ${filtersSql}
               ${edgeGroupBy}
            ) t
           GROUP BY bucket_start, group_name
           ORDER BY 1 ASC, 2 ASC`,
    params,
  };
}
