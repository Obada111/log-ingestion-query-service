import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTestApp, drainWriter, makeLog, type TestApp } from "./helpers.js";

let t: TestApp;

before(async () => {
  t = await setupTestApp();
});
after(async () => {
  await t?.close();
});

async function ingestRows(rows: Array<Record<string, unknown>>) {
  const res = await t.app.inject({ method: "POST", url: "/logs", payload: { logs: rows } });
  assert.equal(res.statusCode, 200);
  await drainWriter(t.writer);
}

describe("GET /logs/aggregate", () => {
  before(async () => {
    const rows: Array<Record<string, unknown>> = [];
    // checkout: 3 errors at 14:01, 1 info at 14:03; auth: 2 warns at 14:01.
    rows.push(makeLog({ timestamp: "2026-07-20T14:01:30Z", service: "checkout", level: "error", attributes: { region: "eu" } }));
    rows.push(makeLog({ timestamp: "2026-07-20T14:01:45Z", service: "checkout", level: "error", attributes: { region: "eu" } }));
    rows.push(makeLog({ timestamp: "2026-07-20T14:01:59Z", service: "checkout", level: "error", attributes: { region: "us" } }));
    rows.push(makeLog({ timestamp: "2026-07-20T14:03:10Z", service: "checkout", level: "info", attributes: { region: "eu" } }));
    rows.push(makeLog({ timestamp: "2026-07-20T14:01:01Z", service: "auth", level: "warn", attributes: { region: "eu" } }));
    rows.push(makeLog({ timestamp: "2026-07-20T14:01:02Z", service: "auth", level: "warn", attributes: { region: "eu" } }));
    await ingestRows(rows);
  });

  const AGG = "since=2026-07-20T14:00:00Z&until=2026-07-20T14:05:00Z";

  it("returns per-bucket counts ordered by start ascending, group null", async () => {
    const res = await t.app.inject({ method: "GET", url: `/logs/aggregate?${AGG}&bucket=1m` });
    assert.equal(res.statusCode, 200);
    const buckets = res.json().buckets;
    assert.deepEqual(
      buckets.map((b: { start: string; count: number }) => [b.start, b.count]),
      [
        ["2026-07-20T14:01:00.000Z", 5],
        ["2026-07-20T14:03:00.000Z", 1],
      ]
    );
    assert.ok(buckets.every((b: { group: unknown }) => b.group === null));
  });

  it("groups by service", async () => {
    const res = await t.app.inject({ method: "GET", url: `/logs/aggregate?${AGG}&bucket=1m&group_by=service` });
    const buckets = res.json().buckets as Array<{ start: string; group: string; count: number }>;
    assert.deepEqual(buckets, [
      { start: "2026-07-20T14:01:00.000Z", group: "auth", count: 2 },
      { start: "2026-07-20T14:01:00.000Z", group: "checkout", count: 3 },
      { start: "2026-07-20T14:03:00.000Z", group: "checkout", count: 1 },
    ]);
  });

  it("groups by level", async () => {
    const res = await t.app.inject({ method: "GET", url: `/logs/aggregate?${AGG}&bucket=1m&group_by=level` });
    const buckets = res.json().buckets as Array<{ group: string; count: number }>;
    assert.deepEqual(buckets, [
      { start: "2026-07-20T14:01:00.000Z", group: "error", count: 3 },
      { start: "2026-07-20T14:01:00.000Z", group: "warn", count: 2 },
      { start: "2026-07-20T14:03:00.000Z", group: "info", count: 1 },
    ]);
  });

  it("supports 5m, 1h and 1d buckets", async () => {
    const five = await t.app.inject({ method: "GET", url: `/logs/aggregate?${AGG}&bucket=5m` });
    assert.equal(five.json().buckets.length, 1);
    assert.equal(five.json().buckets[0].count, 6);
    const hour = await t.app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2026-07-20T00:00:00Z&until=2026-07-21T00:00:00Z&bucket=1h",
    });
    assert.equal(hour.json().buckets[0].start, "2026-07-20T14:00:00.000Z");
    const day = await t.app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2026-07-01T00:00:00Z&until=2026-08-01T00:00:00Z&bucket=1d",
    });
    assert.equal(day.json().buckets[0].start, "2026-07-20T00:00:00.000Z");
  });

  it("omits empty buckets", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2026-07-20T14:02:00Z&until=2026-07-20T14:03:30Z&bucket=1m",
    });
    const buckets = res.json().buckets;
    assert.deepEqual(buckets.map((b: { start: string }) => b.start), ["2026-07-20T14:03:00.000Z"]);
  });

  it("applies service, level, attr and q filters", async () => {
    const byLevel = await t.app.inject({ method: "GET", url: `/logs/aggregate?${AGG}&bucket=1m&level=error` });
    assert.equal(byLevel.json().buckets[0].count, 3);
    const byAttr = await t.app.inject({ method: "GET", url: `/logs/aggregate?${AGG}&bucket=1m&attr.region=eu&group_by=service` });
    assert.deepEqual(byAttr.json().buckets, [
      { start: "2026-07-20T14:01:00.000Z", group: "auth", count: 2 },
      { start: "2026-07-20T14:01:00.000Z", group: "checkout", count: 2 },
      { start: "2026-07-20T14:03:00.000Z", group: "checkout", count: 1 },
    ]);
    const byQ = await t.app.inject({ method: "GET", url: `/logs/aggregate?${AGG}&bucket=1m&q=payment` });
    const qCount = byQ.json().buckets.reduce((n: number, b: { count: number }) => n + b.count, 0);
    assert.equal(qCount, 6); // all six rows mention "payment"
  });

  it("returns empty buckets array for an empty range", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2026-08-01T00:00:00Z&until=2026-08-02T00:00:00Z&bucket=1m",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { buckets: [] });
  });

  it("rejects invalid parameters with 400 {error}", async () => {
    const cases = [
      "/logs/aggregate?bucket=1m", // missing since/until
      "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z", // missing bucket
      "/logs/aggregate?since=bad&until=2026-07-20T15:00:00Z&bucket=1m",
      "/logs/aggregate?since=2026-07-20T14:00:00Z&until=bad&bucket=1m",
      "/logs/aggregate?since=2026-07-20T15:00:00Z&until=2026-07-20T14:00:00Z&bucket=1m",
      "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=7m",
      "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m&group_by=message",
      "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m&level=panic",
    ];
    for (const url of cases) {
      const res = await t.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      assert.equal(typeof res.json().error, "string", url);
    }
  });
});
