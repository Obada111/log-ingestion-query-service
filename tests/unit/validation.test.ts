import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateLogEntry, MAX_FUTURE_SKEW_MS } from "../../src/lib/validation.js";

const valid = {
  timestamp: "2026-07-20T14:32:01.123Z",
  level: "error",
  service: "checkout",
  message: "payment declined",
  attributes: { user_id: "42", region: "eu-west", retries: 3 },
};

describe("validateLogEntry", () => {
  it("accepts a fully valid entry", () => {
    const r = validateLogEntry(valid);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.entry.service, "checkout");
      assert.equal(r.entry.level, "error");
      assert.equal(r.entry.attributes.retries, 3);
    }
  });

  it("accepts an entry without attributes (defaults to {})", () => {
    const { timestamp, level, service, message } = valid;
    const r = validateLogEntry({ timestamp, level, service, message });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.entry.attributes, {});
  });

  it("rejects invalid levels with the contract-style reason", () => {
    const r = validateLogEntry({ ...valid, level: "critical" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /invalid level: 'critical'/);
  });

  it("rejects missing required fields", () => {
    const r = validateLogEntry({ ...valid, service: undefined });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /missing required field: 'service'/);
  });

  it("rejects empty service and empty message", () => {
    for (const patch of [{ service: "" }, { message: "" }]) {
      const r = validateLogEntry({ ...valid, ...patch });
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /non-empty string/);
    }
  });

  it("rejects non-string timestamp", () => {
    const r = validateLogEntry({ ...valid, timestamp: 12345 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /timestamp/);
  });

  it("rejects non-ISO timestamp strings", () => {
    const r = validateLogEntry({ ...valid, timestamp: "yesterday at noon" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /invalid timestamp/);
  });

  it("rejects timestamps more than five minutes in the future", () => {
    const future = new Date(Date.now() + MAX_FUTURE_SKEW_MS + 60_000).toISOString();
    const r = validateLogEntry({ ...valid, timestamp: future });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /five minutes in the future/);
  });

  it("accepts a timestamp five minutes in the future (boundary)", () => {
    const boundary = new Date(Date.now() + MAX_FUTURE_SKEW_MS).toISOString();
    const r = validateLogEntry({ ...valid, timestamp: boundary });
    assert.equal(r.ok, true);
  });

  it("rejects nested attribute objects", () => {
    const r = validateLogEntry({ ...valid, attributes: { user: { id: 1 } } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /nested objects and arrays are not allowed/);
  });

  it("rejects attribute arrays and null values", () => {
    for (const attributes of [{ tags: ["a"] }, { trace: null }]) {
      const r = validateLogEntry({ ...valid, attributes });
      assert.equal(r.ok, false);
    }
  });

  it("accepts string/number/boolean attribute values", () => {
    const r = validateLogEntry({ ...valid, attributes: { s: "x", n: 3.14, b: false } });
    assert.equal(r.ok, true);
  });

  it("ignores unknown extra fields on the entry (lenient)", () => {
    const r = validateLogEntry({ ...valid, trace_id: "abc", nested: { a: 1 } });
    assert.equal(r.ok, true);
  });

  it("rejects non-object entries", () => {
    for (const bad of [null, 42, "string", [], true]) {
      const r = validateLogEntry(bad);
      assert.equal(r.ok, false);
    }
  });
});
