import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { setupTestApp, drainWriter, makeLog, type TestApp } from "./helpers.js";
import { hashApiKey, seedLoadgenKey } from "../../src/auth/keys.js";

const LOADGEN_KEY = "test-loadgen-secret";

let t: TestApp;

async function authApp(): Promise<TestApp> {
  const app = await setupTestApp({ authEnabled: true, loadgenApiKey: LOADGEN_KEY });
  await seedLoadgenKey(app.pool, LOADGEN_KEY);
  return app;
}

describe("auth (AUTH_ENABLED=true)", () => {
  after(async () => {
    await t?.close();
  });

  it("rejects data endpoints without credentials", async () => {
    t = await authApp();
    for (const method of ["POST", "GET"]) {
      const res = await t.app.inject({ method, url: "/logs" });
      assert.equal(res.statusCode, 401);
      assert.equal(typeof res.json().error, "string");
      assert.notEqual(res.json().error, undefined);
    }
    const agg = await t.app.inject({ method: "GET", url: "/logs/aggregate?since=2026-01-01T00:00:00Z&until=2026-01-02T00:00:00Z&bucket=1m" });
    assert.equal(agg.statusCode, 401);
  });

  it("rejects unknown keys and malformed auth headers", async () => {
    t = await authApp();
    const unknown = await t.app.inject({
      method: "GET",
      url: "/logs",
      headers: { authorization: "Bearer not-a-real-key" },
    });
    assert.equal(unknown.statusCode, 401);
    const bare = await t.app.inject({
      method: "GET",
      url: "/logs",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    assert.equal(bare.statusCode, 401);
  });

  it("accepts the seeded key via Bearer and via X-API-Key", async () => {
    t = await authApp();
    for (const headers of [
      { authorization: `Bearer ${LOADGEN_KEY}` },
      { "x-api-key": LOADGEN_KEY },
    ]) {
      const res = await t.app.inject({ method: "GET", url: "/logs", headers });
      assert.equal(res.statusCode, 200, JSON.stringify(headers));
    }
    const post = await t.app.inject({
      method: "POST",
      url: "/logs",
      headers: { authorization: `Bearer ${LOADGEN_KEY}` },
      payload: { logs: [makeLog()] },
    });
    assert.equal(post.statusCode, 200);
  });

  it("enforces scopes: an ingest-only key cannot query", async () => {
    t = await authApp();
    await t.pool.query(
      `INSERT INTO api_keys (key_hash, name, scopes, tenant_id) VALUES ($1, 'ingest-only', ARRAY['ingest'], NULL)`,
      [hashApiKey("ingest-only-key")]
    );
    const ok = await t.app.inject({
      method: "POST",
      url: "/logs",
      headers: { authorization: "Bearer ingest-only-key" },
      payload: { logs: [makeLog()] },
    });
    assert.equal(ok.statusCode, 200);
    const denied = await t.app.inject({
      method: "GET",
      url: "/logs",
      headers: { authorization: "Bearer ingest-only-key" },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(typeof denied.json().error, "string");
  });

  it("keeps /health unauthenticated", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  });

  it("restarting (re-seeding) does not invalidate the key", async () => {
    await seedLoadgenKey(t.pool, LOADGEN_KEY);
    const res = await t.app.inject({
      method: "GET",
      url: "/logs",
      headers: { authorization: `Bearer ${LOADGEN_KEY}` },
    });
    assert.equal(res.statusCode, 200);
  });

  it("seeding stores only a hash, never the plaintext", async () => {
    const rows = await t.pool.query("SELECT key_hash FROM api_keys");
    const hashes = rows.rows.map((r: { key_hash: string }) => r.key_hash);
    assert.ok(hashes.every((h) => !h.includes(LOADGEN_KEY)));
    assert.ok(hashes.includes(hashApiKey(LOADGEN_KEY)));
  });
});

describe("auth off (default)", () => {
  after(async () => {
    await t?.close();
  });

  it("ignores credentials and serves the plain core service", async () => {
    t = await setupTestApp(); // authEnabled=false
    const withCreds = await t.app.inject({
      method: "POST",
      url: "/logs",
      headers: { authorization: `Bearer ${LOADGEN_KEY}` },
      payload: { logs: [makeLog()] },
    });
    assert.equal(withCreds.statusCode, 200);
    const list = await t.app.inject({
      method: "GET",
      url: "/logs",
      headers: { authorization: `Bearer ${LOADGEN_KEY}` },
    });
    assert.equal(list.statusCode, 200);
  });
});

describe("tenant scoping", () => {
  after(async () => {
    await t?.close();
  });

  it("a key with a tenant only sees its own logs", async () => {
    t = await setupTestApp({ authEnabled: true });
    await t.pool.query(
      `INSERT INTO api_keys (key_hash, name, scopes, tenant_id) VALUES ($1, 'tenant-a', ARRAY['ingest','query'], 'a')`,
      [hashApiKey("tenant-a-key")]
    );
    await t.pool.query(
      `INSERT INTO api_keys (key_hash, name, scopes, tenant_id) VALUES ($1, 'tenant-b', ARRAY['ingest','query'], 'b')`,
      [hashApiKey("tenant-b-key")]
    );
    const tenantA = { authorization: "Bearer tenant-a-key" };
    const tenantB = { authorization: "Bearer tenant-b-key" };
    await t.app.inject({
      method: "POST",
      url: "/logs",
      headers: tenantA,
      payload: { logs: [makeLog({ message: "secret-a" })] },
    });
    await t.app.inject({
      method: "POST",
      url: "/logs",
      headers: tenantA,
      payload: { logs: [makeLog({ message: "secret-a-2" })] },
    });
    await t.app.inject({
      method: "POST",
      url: "/logs",
      headers: tenantB,
      payload: { logs: [makeLog({ message: "secret-b" })] },
    });
    await drainWriter(t.writer);

    const list = await t.app.inject({ method: "GET", url: "/logs", headers: tenantA });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().logs.length, 2);
    assert.ok(list.json().logs.every((l: { message: string }) => l.message.startsWith("secret-a")));

    const agg = await t.app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m",
      headers: tenantA,
    });
    assert.equal(agg.json().buckets[0].count, 2);
  });
});
