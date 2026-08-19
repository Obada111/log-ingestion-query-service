import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAggregateQuery,
  buildLogsQuery,
  escapeLike,
  parseAggregateParams,
  parseListParams,
} from "../../src/lib/queryParams.js";
import { encodeCursor } from "../../src/lib/cursor.js";

describe("parseListParams", () => {
  it("defaults: limit 100, no cursor, no filters", () => {
    const r = parseListParams({});
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.limit, 100);
      assert.equal(r.value.cursor, null);
      assert.deepEqual(r.value.filters.attrPairs, []);
    }
  });

  it("parses every supported filter", () => {
    const r = parseListParams({
      service: "checkout",
      level: "warn",
      since: "2026-07-20T14:00:00Z",
      until: "2026-07-20T15:00:00Z",
      "attr.user_id": "42",
      "attr.region": "eu-west",
      q: "declined",
      limit: "500",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      const { filters, limit } = r.value;
      assert.equal(limit, 500);
      assert.equal(filters.service, "checkout");
      assert.equal(filters.level, "warn");
      assert.deepEqual(filters.attrPairs, [["user_id", "42"], ["region", "eu-west"]]);
      assert.equal(filters.q, "declined");
    }
  });

  it("accepts a valid cursor", () => {
    const cursor = encodeCursor(new Date("2026-07-20T14:00:00Z"), "7");
    const r = parseListParams({ cursor });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.cursor?.id, "7");
  });

  it("rejects invalid values with {ok:false, error}", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ level: "fatal" }, /unsupported level/],
      [{ since: "not a date" }, /invalid timestamp/],
      [{ until: "2026-01-01" }, /invalid timestamp/],
      [{ since: "2026-07-20T15:00:00Z", until: "2026-07-20T14:00:00Z" }, /until must not be earlier than since/],
      [{ limit: "abc" }, /limit must be a non-negative integer/],
      [{ limit: "0" }, /limit must be between 1 and 1000/],
      [{ limit: "1001" }, /limit must be between 1 and 1000/],
      [{ cursor: "!!!not-a-cursor!!!" }, /invalid cursor/],
      [{ cursor: Buffer.from('{"ts":"bad","id":"1"}').toString("base64url") }, /invalid cursor/],
      [{ service: "" }, /service must be a non-empty string/],
      [{ "attr.": "x" }, /invalid attribute key/],
    ];
    for (const [query, pattern] of cases) {
      const r = parseListParams(query);
      assert.equal(r.ok, false, `expected failure for ${JSON.stringify(query)}`);
      if (!r.ok) assert.match(r.error, pattern);
    }
  });

  it("ignores unknown parameters (lenient)", () => {
    const r = parseListParams({ foo: "bar", "attr": "no-prefix-match" });
    assert.equal(r.ok, true);
  });

  it("handles repeated parameters by taking the first", () => {
    const r = parseListParams({ level: ["info", "error"] });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.filters.level, "info");
  });

  it("accepts until === since (empty range, not an error)", () => {
    const r = parseListParams({ since: "2026-07-20T14:00:00Z", until: "2026-07-20T14:00:00Z" });
    assert.equal(r.ok, true);
  });
});

describe("parseAggregateParams", () => {
  const base = { since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z", bucket: "1m" };

  it("requires since, until and bucket", () => {
    for (const missing of ["since", "until", "bucket"]) {
      const q = { ...base };
      delete (q as Record<string, string>)[missing];
      const r = parseAggregateParams(q);
      assert.equal(r.ok, false);
    }
  });

  it("accepts all four bucket sizes", () => {
    for (const bucket of ["1m", "5m", "1h", "1d"]) {
      const r = parseAggregateParams({ ...base, bucket });
      assert.equal(r.ok, true);
    }
  });

  it("rejects unknown buckets and group_by values", () => {
    assert.equal(parseAggregateParams({ ...base, bucket: "7m" }).ok, false);
    assert.equal(parseAggregateParams({ ...base, group_by: "message" }).ok, false);
  });

  it("accepts group_by service and level", () => {
    for (const groupBy of ["service", "level"]) {
      const r = parseAggregateParams({ ...base, group_by: groupBy });
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value.groupBy, groupBy);
    }
  });
});

describe("escapeLike", () => {
  it("escapes LIKE metacharacters", () => {
    assert.equal(escapeLike("50%_off\\x"), "50\\%\\_off\\\\x");
  });
  it("leaves plain text untouched", () => {
    assert.equal(escapeLike("payment declined"), "payment declined");
  });
});

describe("buildLogsQuery", () => {
  it("produces parameterized SQL with no raw user input", () => {
    const q = buildLogsQuery({
      filters: {
        service: "checkout",
        level: "error",
        since: new Date("2026-07-20T14:00:00Z"),
        attrPairs: [["user_id", "42; DROP TABLE logs;--"]],
        q: "declined%",
      },
      limit: 100,
      cursor: null,
    });
    assert.equal(q.params.length, 5);
    assert.ok(q.sql.includes("$1"), "params numbered from $1");
    assert.ok(!q.sql.includes("DROP TABLE"), "no injection possible");
    assert.ok(q.sql.includes("LIMIT 101"), "limit+1 probe");
    assert.ok(q.sql.includes("ORDER BY ts DESC, id DESC"));
  });

  it("includes a keyset cursor predicate when a cursor is provided", () => {
    const q = buildLogsQuery({
      filters: { attrPairs: [] },
      limit: 10,
      cursor: { ts: "2026-07-20T14:00:00Z", id: "42" },
    });
    assert.ok(q.sql.includes("ts < $1 OR (ts = $1 AND id < $2)"));
    assert.equal(q.params.length, 2);
  });
});

describe("buildAggregateQuery", () => {
  it("uses the rollup path (log_counts + edge scans) with no attr/q filters", () => {
    const q = buildAggregateQuery({
      filters: { attrPairs: [] },
      since: new Date("2026-07-20T14:00:00Z"),
      until: new Date("2026-07-20T15:00:00Z"),
      bucket: "5m",
      groupBy: null,
    });
    assert.equal(q.params.length, 3, "since, until, interval params");
    assert.ok(q.sql.includes("date_bin($3::interval"), "interval is the 3rd param");
    assert.ok(q.sql.includes("log_counts"), "rollup table is read");
    assert.ok(q.sql.includes("GROUP BY bucket_start, group_name"));
    assert.ok(q.sql.includes("NULL::text AS group_name"));
    assert.ok(!q.sql.includes("GROUP BY 1, service"));
  });

  it("whitelists group columns on the rollup path", () => {
    const q = buildAggregateQuery({
      filters: { attrPairs: [] },
      since: new Date("2026-07-20T14:00:00Z"),
      until: new Date("2026-07-20T15:00:00Z"),
      bucket: "1h",
      groupBy: "service",
    });
    assert.ok(q.sql.includes("service AS group_name"));
    assert.equal(q.params.length, 3);
  });

  it("falls back to a direct scan when attr filters are present", () => {
    const q = buildAggregateQuery({
      filters: { attrPairs: [["region", "eu"]] },
      since: new Date("2026-07-20T14:00:00Z"),
      until: new Date("2026-07-20T15:00:00Z"),
      bucket: "1m",
      groupBy: null,
    });
    assert.ok(q.sql.includes("FROM logs"), "direct scan");
    assert.ok(q.sql.includes("GROUP BY 1"));
    assert.ok(q.sql.includes("attributes @>"), "typed attribute probe");
  });

  it("falls back to a direct scan when q filters are present", () => {
    const q = buildAggregateQuery({
      filters: { attrPairs: [], q: "declined" },
      since: new Date("2026-07-20T14:00:00Z"),
      until: new Date("2026-07-20T15:00:00Z"),
      bucket: "5m",
      groupBy: "level",
    });
    assert.ok(q.sql.includes("FROM logs"), "direct scan");
    assert.ok(q.sql.includes("GROUP BY 1, level"));
  });
});
