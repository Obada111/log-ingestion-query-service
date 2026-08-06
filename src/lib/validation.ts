import { Ajv, type ErrorObject } from "ajv";
import addFormatsPlugin from "ajv-formats";

// TS's NodeNext mode types the default import of this CJS package as the
// module namespace; at runtime Node correctly gives us the plugin function.
// The cast bridges the two without weakening anything else.
const addFormats = addFormatsPlugin as unknown as (ajv: Ajv) => void;

/**
 * Per-entry validation for POST /logs.
 *
 * The contract requires per-entry validation with per-index rejection
 * reasons — an invalid entry must never fail the whole batch. Validation
 * also runs on the hot path (15k logs/s), so the schema is compiled once
 * by Ajv into an optimized predicate (~1-2ms per 1000 entries).
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type AttributeValue = string | number | boolean;

/** The validated, DB-ready form of one log entry. */
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Record<string, AttributeValue>;
}

export interface RejectedEntry {
  index: number;
  reason: string;
}

/** Maximum allowed skew between the server clock and the log timestamp. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schema + compiled validator
// ---------------------------------------------------------------------------

const entrySchema = {
  type: "object",
  properties: {
    timestamp: { type: "string", format: "date-time" },
    level: { type: "string", enum: [...LOG_LEVELS] },
    service: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
    // Flat object only: values are strings, numbers or booleans. The value
    // type constraint rejects nested objects, arrays and null automatically.
    attributes: {
      type: "object",
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
  },
  required: ["timestamp", "level", "service", "message"],
} as const;

// allowUnionTypes: the attributes value schema intentionally allows a union
// of scalar types; Ajv's strict mode warns about it otherwise.
const ajv = new Ajv({ allErrors: false, coerceTypes: false, allowUnionTypes: true });
addFormats(ajv);
const validateEntry = ajv.compile(entrySchema);

/**
 * Translate an Ajv error into a human-readable reason string. The contract's
 * example reason is `invalid level: 'critical'`; we keep that exact phrasing
 * style for enum failures.
 */
function reasonForError(err: ErrorObject, raw: unknown): string {
  const field = err.instancePath.replace(/^\//, "") || "entry";
  const record = raw as Record<string, unknown>;
  switch (err.keyword) {
    case "required": {
      const missing = err.params.missingProperty;
      const name = Array.isArray(missing) ? missing.join(", ") : String(missing);
      return `missing required field: '${name}'`;
    }
    case "enum":
      return `invalid level: '${String(record.level)}'`;
    case "format":
      return `invalid timestamp: '${String(record.timestamp)}'`;
    case "minLength":
      return `${field} must be a non-empty string`;
    case "type":
      if (field === "attributes")
        return "attributes must be a flat object of string, number or boolean values";
      if (field.startsWith("attributes/"))
        return `attribute '${field.slice("attributes/".length)}' must be a string, number or boolean; nested objects and arrays are not allowed`;
      return `${field} must be a ${String(err.params.type)}`;
    default:
      return `invalid ${field}: ${err.message ?? "value"}`;
  }
}

/**
 * Validate one raw entry. Returns either a ready-to-insert LogEntry or a
 * rejection reason. Pure function — no I/O — so it is trivially testable.
 */
export function validateLogEntry(raw: unknown): { ok: true; entry: LogEntry } | { ok: false; reason: string } {
  if (!validateEntry(raw)) {
    const first = validateEntry.errors?.[0];
    return { ok: false, reason: first ? reasonForError(first, raw) : "invalid entry" };
  }

  const entry = raw as {
    timestamp: string;
    level: LogLevel;
    service: string;
    message: string;
    attributes?: Record<string, AttributeValue>;
  };

  const timestamp = new Date(entry.timestamp);
  // Contract: timestamps must not be more than five minutes in the future.
  if (timestamp.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: "timestamp must not be more than five minutes in the future" };
  }

  return {
    ok: true,
    entry: {
      timestamp,
      level: entry.level,
      service: entry.service,
      message: entry.message,
      attributes: entry.attributes ?? {},
    },
  };
}
