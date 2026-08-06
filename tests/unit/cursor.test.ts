import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor } from "../../src/lib/cursor.js";

describe("cursor codec", () => {
  it("round-trips", () => {
    const cursor = encodeCursor(new Date("2026-07-20T14:32:01.123Z"), "123456789012345678");
    const decoded = decodeCursor(cursor);
    assert.deepEqual(decoded, { ts: "2026-07-20T14:32:01.123Z", id: "123456789012345678" });
  });

  it("handles large ids as strings without precision loss", () => {
    const cursor = encodeCursor(new Date("2026-01-01T00:00:00Z"), "9007199254740993123");
    assert.deepEqual(decodeCursor(cursor), {
      ts: "2026-01-01T00:00:00.000Z",
      id: "9007199254740993123",
    });
  });

  it("rejects malformed cursors", () => {
    for (const bad of [
      "",
      "not-base64!!",
      "abc",
      Buffer.from('{"ts": 123}', "utf8").toString("base64url"),
      Buffer.from('{"id": "1"}', "utf8").toString("base64url"),
      Buffer.from('{"ts": "not-a-date", "id": "1"}', "utf8").toString("base64url"),
      Buffer.from('{"ts": "2026-01-01T00:00:00Z", "id": "1.5"}', "utf8").toString("base64url"),
      Buffer.from('{"ts": "2026-01-01T00:00:00Z", "id": "-3"}', "utf8").toString("base64url"),
      Buffer.from("garbage", "utf8").toString("base64url"),
    ]) {
      assert.equal(decodeCursor(bad), null, `should reject: ${bad}`);
    }
  });

  it("rejects oversized cursors", () => {
    const huge = "a".repeat(2049);
    assert.equal(decodeCursor(huge), null);
  });
});
