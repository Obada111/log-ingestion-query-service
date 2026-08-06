/**
 * Keyset (cursor-based) pagination.
 *
 * OFFSET pagination re-scans and discards `offset` rows per page — O(n²)
 * total work — and pages shift as new rows arrive. Keyset pagination resumes
 * from the last row of the previous page:
 * `WHERE (ts < $lastTs) OR (ts = $lastTs AND id < $lastId)` with
 * `ORDER BY ts DESC, id DESC`, so each page costs O(page size) regardless of
 * depth.
 *
 * The cursor is opaque to clients (base64url(JSON)) and strictly validated
 * on decode, so a malformed cursor yields HTTP 400, never a crash.
 */

export interface Cursor {
  /** ISO 8601 timestamp of the last row, kept as string to avoid TZ drift. */
  ts: string;
  /** Row id as string — BIGSERIAL exceeds Number.MAX_SAFE_INTEGER at 2^53 rows. */
  id: string;
}

export function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(JSON.stringify({ ts: ts.toISOString(), id })).toString("base64url");
}

/** Decode and strictly validate a cursor. Returns null when malformed. */
export function decodeCursor(raw: string): Cursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { ts, id } = parsed as { ts?: unknown; id?: unknown };
    if (typeof ts !== "string" || typeof id !== "string") return null;
    if (Number.isNaN(Date.parse(ts))) return null;
    if (!/^\d{1,19}$/.test(id)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}
