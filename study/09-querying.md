# 09. Querying — the GET /logs pipeline

## Summary

`GET /logs` is the filtered log-listing endpoint: it parses and strictly validates query parameters, builds a fully parameterized SQL statement, executes it through the service layer, and returns one page of logs plus an opaque cursor for the next page. The pipeline is split into three layers so no HTTP handler ever touches SQL: parameter parsing in `lib/queryParams.ts`, SQL building in the same module, and persistence/mapping in `services/logService.ts`. Every user-supplied value becomes a `$n` placeholder, which makes SQL injection structurally impossible while letting node-pg reuse server-side prepared statements. The query supports service/level equality, a `since`/`until` timestamp window, case-insensitive message substring search, attribute equality via the GIN-indexed `attr_lookup` column, tenant scoping, and keyset pagination.

## Detailed explanation

**Layer 1 — parameter parsing.** The handler calls `parseListParams(req.query)` ([src/lib/queryParams.ts:52](../src/lib/queryParams.ts#L52)). The parser is deliberately *lenient* about unknown parameters (the load generator may add extras) but *strict* about known ones, because the contract demands HTTP 400 with `{"error": ...}` for invalid input. Repeated parameters arrive as arrays and the first value wins. Each known parameter gets validated:

- `service` — must be a non-empty string.
- `level` — must be in `LOG_LEVELS` (`debug | info | warn | error`, from [src/lib/validation.ts:20](../src/lib/validation.ts#L20)).
- `since`/`until` — must match an ISO-8601 shape (`^\d{4}-\d{2}-\d{2}T`) and parse to a real date; `until` may not precede `since`.
- `limit` — must be a plain integer between 1 and 1000, defaulting to 100.
- `cursor` — must decode through `decodeCursor`, otherwise `invalid cursor`.
- `q` — a non-empty substring to search in messages.
- `attr.<key>` — any key prefixed by `attr.` ([src/lib/queryParams.ts:31](../src/lib/queryParams.ts#L31)) becomes an attribute equality pair `(key, value)`.

The parser returns a typed `ListFilters` struct: `service`, `level`, `since`, `until`, `attrPairs`, `q` ([src/lib/queryParams.ts:15](../src/lib/queryParams.ts#L15)).

**Layer 2 — SQL building.** `buildLogsQuery` ([src/lib/queryParams.ts:248](../src/lib/queryParams.ts#L248)) calls `buildLogsWhere` ([src/lib/queryParams.ts:194](../src/lib/queryParams.ts#L194)), which accumulates clauses and parameters in lock-step. A tiny helper `t(v)` pushes a value into the params array and returns the next `$n` placeholder, guaranteeing numbering is sequential and user text never enters the SQL string:

- `ts >= $n` / `ts < $n` — half-open window (`until` is exclusive).
- `service = $n`, `level = $n` — exact equality.
- `attr_lookup @> $n::jsonb` — attribute equality runs containment on the canonicalized, string-valued column (see study/12).
- `message ILIKE '%' || $n || '%' ESCAPE '\'` — case-insensitive substring; `escapeLike` ([src/lib/queryParams.ts:237](../src/lib/queryParams.ts#L237)) backslash-escapes `%`, `_` and `\` in the user's input so a literal `50%` doesn't match "fifty followed by anything".
- `tenant_id = $n` or `tenant_id IS NULL` — tenant scoping from the auth context.
- `(ts < $ts OR (ts = $ts AND id < $id))` — keyset resume predicate; the timestamp placeholder is bound once and reused, so two cursor values cost only one extra parameter.

The final statement is `SELECT id, ts, level, service, message, attributes FROM logs <where> ORDER BY ts DESC, id DESC LIMIT <limit+1>` ([src/lib/queryParams.ts:257](../src/lib/queryParams.ts#L257)). `LIMIT` is inlined — but only because it is a validated integer from parsing, never raw user text.

**Layer 3 — service and response.** `queryLogs` ([src/services/logService.ts:26](../src/services/logService.ts#L26)) executes the statement, then applies the limit+1 probe: if more than `limit` rows came back, a next page exists. The page is sliced to `limit`, rows are mapped to the contract shape (id as string, `ts` as ISO string, attributes with original types), and — if there is another page — `encodeCursor(last.ts, String(last.id))` produces the opaque `next_cursor`.

**Parameterization and injection safety.** Every value travels as a `$n` parameter, so PostgreSQL treats it as data. node-pg uses the same constant SQL text to reuse server-side prepared statements, skipping parse cost per call. The only interpolated identifiers are compile-time whitelists (`GROUP_COLUMNS` in the aggregate builder), which is the documented "safe dynamic-query construction" pattern.

**Measured behavior.** During the contract-scale run (15k logs/s ingestion, 1.2M rows) the list query p95 was ~161ms — well inside the budget.

## Why this exists

Filtering and paginating a growing log table is the core read path of a Loki/Datadog-style service, and it must behave identically regardless of how much data has accumulated. This layered pipeline exists so the endpoint is (a) contract-compliant — every invalid input yields a specific 400; (b) injection-safe — no user text is ever interpolated into SQL; (c) index-friendly — filters map 1:1 to the designed indexes; and (d) stable under load — pagination never drifts when rows are inserted concurrently (see study/11).

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| String-concatenated SQL with escaping | Simple to write, flexible | Escaping is easy to get wrong; SQL injection risk; no prepared-statement reuse; rejected on security grounds |
| Dynamic SQL libraries (knex, Kysely, Query Builder) | Nicer ergonomics, escape-proof API | Extra dependency on a 0.5-CPU container; the queries here are few and simple enough to hand-build |
| ORM (TypeORM, Prisma) | Models + migrations in one place | Heavy runtime, harder to control exact SQL for `date_bin`/`@>`/`ctid`-style statements; hides what the planner sees |
| Named parameters (`@name` style) | Self-documenting | pg/native protocol uses positional `$n`; named parameters add a mapping layer for no gain here |

## Why this was chosen

The project constraint set — 0.5 CPU / 256MB app, 1 CPU / 1GB PostgreSQL, 15k logs/s, 1M rows, p95 aggregate < 1s — rewards keeping the app thin and the SQL predictable. Hand-built parameterized SQL is zero-overhead, produces exact statements the planner was designed around (verified with EXPLAIN), and reuses node-pg's prepared-statement cache. The two-file separation (parser + builder in `queryParams.ts`, executor in `logService.ts`) keeps handlers trivial and makes the entire query surface unit-testable without a database — 35 unit tests run with no DB needed.

## Advantages / Disadvantages / Trade-offs

### Advantages
- Structurally injection-safe: `$n` placeholders for all values, whitelists for all identifiers.
- Lenient-unknown / strict-known parsing satisfies both the contract (400s) and real load generators.
- Prepared-statement reuse on the hot path (constant SQL text).
- Filters map cleanly to the index design, verified by EXPLAIN at 1.2M rows.
- Tenant scoping is a single optional WHERE clause — the default path has zero overhead.

### Disadvantages
- Hand-built SQL duplicates some logic a query builder would provide for free.
- The parser is ~60 lines of switch logic that must be kept in sync with the API contract by hand.
- `q` substring search with `ILIKE '%...%'` cannot use a B-tree index — it is inherently a scan within the filtered range.

### Trade-offs
- `LIMIT` is inlined (not parameterized) to save a round-trip; safe only because of strict integer validation — a trade of absolute purity for performance.
- Lenient handling of unknown parameters means typos in filters silently return unfiltered results; strictness was deliberately applied only where the contract demands 400s.

## Code

**Parameter parsing** ([src/lib/queryParams.ts:52](../src/lib/queryParams.ts#L52)):

```ts
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
      // ... since, until, limit (1..1000), cursor, q ...
      default:
        if (key.startsWith(ATTR_PREFIX)) {
          const attrKey = key.slice(ATTR_PREFIX.length);
          if (attrKey.length === 0) return fail("invalid attribute key");
          filters.attrPairs.push([attrKey, value]);
        }
    }
  }
  // ...
  return ok({ filters, limit, cursor });
}
```

Every user value ends up inside `filters` as data; nothing here is ever concatenated into SQL.

**WHERE builder with `$n` numbering** ([src/lib/queryParams.ts:194](../src/lib/queryParams.ts#L194)):

```ts
export function buildLogsWhere(opts: WhereOptions): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const t = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  if (filters.since) clauses.push(`ts >= ${t(filters.since)}`);
  if (filters.until) clauses.push(`ts < ${t(filters.until)}`);
  if (filters.service) clauses.push(`service = ${t(filters.service)}`);
  if (filters.level) clauses.push(`level = ${t(filters.level)}`);
  for (const [key, value] of filters.attrPairs) {
    clauses.push(`attr_lookup @> ${t(JSON.stringify({ [key]: value }))}::jsonb`);
  }
  if (filters.q) {
    clauses.push(`message ILIKE '%' || ${t(escapeLike(filters.q))} || '%' ESCAPE '\\'`);
  }
  if (tenantId === null) clauses.push("tenant_id IS NULL");
  else if (typeof tenantId === "string") clauses.push(`tenant_id = ${t(tenantId)}`);
  if (cursor) {
    const tsParam = t(cursor.ts);
    const idParam = t(cursor.id);
    clauses.push(`(ts < ${tsParam} OR (ts = ${tsParam} AND id < ${idParam}))`);
  }
  // ...
}
```

**Service + limit+1 probe** ([src/services/logService.ts:26](../src/services/logService.ts#L26)):

```ts
const res = await pool.query(sql, params);
// We fetched limit+1 rows: the extra row proves a next page exists.
const hasMore = rows.length > limit;
const page = hasMore ? rows.slice(0, limit) : rows;
// ...
return {
  logs,
  nextCursor: hasMore && last ? encodeCursor(last.ts, String(last.id)) : null,
};
```

## Diagrams

```mermaid
sequenceDiagram
    participant C as Client
    participant H as Fastify handler (routes/logs.ts)
    participant P as parseListParams
    participant B as buildLogsQuery
    participant S as queryLogs (service)
    participant D as PostgreSQL

    C->>H: GET /logs?service=web&level=info&q=timeout&limit=50&cursor=...
    H->>P: parseListParams(query)
    P-->>H: ok {filters, limit, cursor} | fail -> 400 {"error": "..."}
    H->>B: buildLogsQuery(filters, limit, cursor, tenant)
    B-->>H: SQL (SELECT ... WHERE ... ORDER BY ts DESC, id DESC LIMIT 51)
    H->>S: queryLogs(pool, filters, limit, cursor)
    S->>D: pool.query(sql, params)
    D-->>S: rows (limit+1 max)
    S->>S: hasMore = rows.length > limit; slice; encodeCursor(last)
    S-->>H: {logs, next_cursor}
    H-->>C: 200 {"logs": [...], "next_cursor": "..."}
```

## Common mistakes

- **Interpolating the cursor or `q` into SQL.** User-controlled text must only ever appear as `$n` values; the builder's `t()` helper makes this the only path.
- **Forgetting `ESCAPE '\'` with ILIKE.** Without it, a user's literal `%` acts as a wildcard; `escapeLike` backslash-escapes `\`, `%`, `_` first.
- **Matching attributes against the typed `attributes` column.** `attr.retries=3` must match the number `3` too — only the canonicalized `attr_lookup` string column makes this work (see study/12).
- **Numbering parameters by hand.** The builder numbers sequentially; a caller appending its own parameter must use `params.length + 1` (the aggregate builder does exactly this for the interval).
- **Treating `since`/`until` as inclusive.** The contract is `>=` / `<`; a `<=` window would double-count the boundary second.
- **Scanning the whole table on a `q` filter.** `ILIKE '%...%'` is inherently non-indexed; pair it with a `since` window to bound the scan.

## Optimization ideas

- **pg_trgm GIN index** on `message` to make `q` substring searches index-assisted instead of range-scans.
- **Bounded scans**: require or default `since` so unfiltered list queries never walk the whole table.
- **Projection hints**: select only needed columns for list views (already minimal here).
- **Query result caching** for hot filters, with TTL — careful with the "rows are visible instantly" contract.
- **Read replicas / separate pool for heavy aggregates** if list p95 must stay flat while aggregates run (the read pool already isolates them from the writer).
- **Streaming pagination** for very large exports (cursor-based walks with a `ts`-only index) instead of in-memory page assembly.

## Interview questions & answers

**Q1: Why is every value a `$n` placeholder instead of concatenated into the query?**
A1: Parameterization separates SQL structure from data — PostgreSQL parses the constant statement once and treats parameter bytes as literal values, so injection is structurally impossible and prepared statements can be reused. The only text ever inlined (`LIMIT`, `group_by`) comes from validated integers or compile-time whitelists.

**Q2: What is the limit+1 probe and why do it in the app rather than with `LIMIT` + a separate count query?**
A2: The query fetches `limit+1` rows; if the result set has more than `limit` rows a next page exists. This avoids a second `SELECT count(*)` (which would be expensive over a filtered range) and stays race-free — the decision is made from the same snapshot as the page itself.

**Q3: How do you make `q=50%` match the literal text "50%" and not "fifty-anything"?**
A3: `escapeLike` backslash-escapes `\`, `%` and `_` before the value is bound, and the ILIKE clause declares `ESCAPE '\'`, so the escaped characters are treated as literals.

**Q4: Why does the parser ignore unknown parameters but reject bad values for known ones?**
A4: The contract guarantees 400 for invalid input on the documented parameters, so those are validated strictly. Unknown parameters must be tolerated because the load generator and future clients may send extras — being strict there would break compatibility for no contract benefit.

**Q5: How is tenant scoping expressed and why three cases?**
A5: `TenantScope = string | null | undefined`: undefined means no scoping (auth disabled), null means "only rows with `tenant_id IS NULL`", a string means exactly that tenant. Each maps to a different WHERE clause, and the default path adds zero SQL overhead.

**Q6: Why is `until` exclusive (`ts < $n`)?**
A6: Half-open intervals compose cleanly: `[since, until)` buckets and windows tile without double-counting boundaries, which matters when `until` is reused as the next window's `since`.

**Q7: What makes the statement prepared-statement friendly, and why does it matter on a 0.5-CPU app?**
A7: The SQL text is identical on every call (only parameter arrays change), so node-pg reuses the server-side prepared statement and PostgreSQL skips re-parsing — measurable CPU savings on the query path.

**Q8: How would you add a `message=contains`-style regex search safely?**
A8: Keep it parameterized (a `$n` with a validated regex), reject pathological patterns (length/catastrophic-backtracking guards), and consider pg_trgm if it becomes hot. Never interpolate the pattern into the SQL string.

**Q9: The list query p95 was ~161ms under full ingestion load — what would you check first if it degraded?**
A9: `pg_stat_activity` for long-running aggregates hogging the pool, EXPLAIN ANALYZE for a plan change (missing index, seq scan), shared_buffers hit ratio for working-set spill, and the app's GC/memory profile for buffer pressure.

**Q10: Why does the response return `id` as a string?**
A10: `id` is BIGSERIAL, which exceeds `Number.MAX_SAFE_INTEGER` at 2^53 rows; JSON numbers above that lose precision, so ids are serialized as strings (same reasoning as the cursor's id field).

**Q11: Could this handler be made fully async off the app?**
A11: It already is — Fastify handlers are async and the DB work happens on pg's connection pool; the only CPU work (parsing, mapping) is small. Moving SQL to a stored function would trade flexibility for marginal gain.

**Q12: What is the difference between this endpoint and a typical ORM `findAll`?**
A12: This hand-built query gives exact control over the plan (ORDER BY + cursor predicate, `@>` containment, `LIMIT limit+1`) that an ORM's generic API cannot express without raw fragments, and it carries no runtime dependency cost.

## Implementation references

- [src/lib/queryParams.ts:52](../src/lib/queryParams.ts#L52) — `parseListParams` (strict validation, lenient unknowns, attr prefix)
- [src/lib/queryParams.ts:194](../src/lib/queryParams.ts#L194) — `buildLogsWhere` (parameterized clauses, cursor predicate, tenant scoping)
- [src/lib/queryParams.ts:237](../src/lib/queryParams.ts#L237) — `escapeLike`
- [src/lib/queryParams.ts:248](../src/lib/queryParams.ts#L248) — `buildLogsQuery` (ORDER BY ts DESC, id DESC; LIMIT limit+1)
- [src/services/logService.ts:26](../src/services/logService.ts#L26) — `queryLogs` (limit+1 probe, nextCursor)
- [src/routes/logs.ts:132](../src/routes/logs.ts#L132) — GET /logs handler wiring
- [src/routes/logs.ts:27](../src/routes/logs.ts#L27) — tenant resolution from auth context
- [src/lib/validation.ts:20](../src/lib/validation.ts#L20) — `LOG_LEVELS` whitelist
- [../README.md:62](../README.md#L62) — contract for GET /logs
- [../README.md:145](../README.md#L145) — measured list query p95 ~161ms during ingestion
