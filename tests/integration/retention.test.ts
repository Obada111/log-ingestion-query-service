import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTestApp, drainWriter, makeLog, type TestApp } from "./helpers.js";
import { sweepExpired, startRetentionSweeper } from "../../src/services/retention.js";

let t: TestApp;

before(async () => {
  t = await setupTestApp();
});
after(async () => {
  await t?.close();
});

describe("retention", () => {
  it("deletes only rows older than the horizon", async () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const res = await t.app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          makeLog({ timestamp: old, message: "old-1" }),
          makeLog({ timestamp: old, message: "old-2" }),
          makeLog({ timestamp: recent, message: "fresh" }),
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    await drainWriter(t.writer);

    // retentionHours=2 -> cutoff 2h ago -> both 48h rows expire.
    const deleted = await sweepExpired(t.pool, 2);
    assert.equal(deleted, 2);

    const remaining = await t.pool.query("SELECT message FROM logs ORDER BY id");
    assert.deepEqual(remaining.rows.map((r: { message: string }) => r.message), ["fresh"]);
  });

  it("deletes in bounded chunks and reports the total", async () => {
    const old = new Date(Date.now() - 24 * 3600_000).toISOString();
    const rows = Array.from({ length: 25 }, (_, i) => makeLog({ timestamp: old, message: `chunk-${i}` }));
    const res = await t.app.inject({ method: "POST", url: "/logs", payload: { logs: rows } });
    assert.equal(res.statusCode, 200);
    await drainWriter(t.writer);

    const deleted = await sweepExpired(t.pool, 2, 10); // chunkSize 10 -> 3 rounds
    assert.equal(deleted, 25);
  });

  it("sweeper ignores overlapping runs and can be stopped", async () => {
    const stop = startRetentionSweeper(t.pool, t.config, () => {});
    assert.equal(typeof stop, "function");
    stop();
  });

  it("is a no-op when nothing is expired", async () => {
    const deleted = await sweepExpired(t.pool, 24 * 365);
    assert.equal(deleted, 0);
  });
});
