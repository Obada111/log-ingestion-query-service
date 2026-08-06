import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { IngestWriter } from "../services/ingestWriter.js";
import { validateLogEntry, type RejectedEntry } from "../lib/validation.js";
import { parseAggregateParams, parseListParams } from "../lib/queryParams.js";
import { aggregateLogs, queryLogs } from "../services/logService.js";
import { createAuthHook, type RequiredScope } from "../auth/middleware.js";
import type { TenantScope } from "../lib/queryParams.js";

/**
 * HTTP layer. Handlers only: parse -> validate -> call services -> shape
 * responses. No SQL here; see services/ and lib/queryParams.js.
 */

interface LogRoutesDeps {
  config: Config;
  pool: Pool;
  writer: IngestWriter;
}

export function registerLogRoutes(app: FastifyInstance, deps: LogRoutesDeps): void {
  const auth = (scope: RequiredScope) => createAuthHook(deps.pool, deps.config, scope);

  // Resolve tenant scope: undefined = no scoping (auth off or key without
  // tenant), null = tenantless rows, string = that tenant.
  const tenantOf = (req: FastifyRequest): TenantScope =>
    req.authContext === undefined ? undefined : req.authContext.tenantId;

  // -------------------------------------------------------------------------
  // POST /logs — batch ingestion with per-entry validation
  // -------------------------------------------------------------------------
  app.post(
    "/logs",
    {
      onRequest: [auth("ingest")],
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              accepted: { type: "integer" },
              rejected: {
                type: "array",
                items: {
                  type: "object",
                  properties: { index: { type: "integer" }, reason: { type: "string" } },
                  required: ["index", "reason"],
                },
              },
            },
            required: ["accepted", "rejected"],
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body: unknown = req.body;
      if (typeof body !== "object" || body === null || !Array.isArray((body as { logs?: unknown }).logs)) {
        return reply.code(400).send({ error: "request body must be a JSON object with a 'logs' array" });
      }

      const rows = (body as { logs: unknown[] }).logs;
      const accepted: import("../services/ingestWriter.js").IngestRow[] = [];
      const rejected: RejectedEntry[] = [];
      const tenantId = tenantOf(req) ?? null;

      for (let i = 0; i < rows.length; i++) {
        const result = validateLogEntry(rows[i]);
        if (result.ok) {
          const e = result.entry;
          accepted.push({
            timestamp: e.timestamp,
            level: e.level,
            service: e.service,
            message: e.message,
            attributes: e.attributes,
            tenantId,
          });
        } else {
          rejected.push({ index: i, reason: result.reason });
        }
      }

      // Contract: 400 when every entry was rejected.
      if (accepted.length === 0) {
        return reply.code(400).send({ accepted: 0, rejected });
      }

      // Blocks until the coalescing writer durably commits these rows.
      // A throw here -> Fastify 500; we never report 200 without durability.
      await deps.writer.submit(accepted);

      return reply.code(200).send({ accepted: accepted.length, rejected });
    }
  );

  // -------------------------------------------------------------------------
  // GET /logs — filtered query with cursor pagination
  // -------------------------------------------------------------------------
  app.get(
    "/logs",
    {
      onRequest: [auth("query")],
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              logs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    timestamp: { type: "string" },
                    level: { type: "string" },
                    service: { type: "string" },
                    message: { type: "string" },
                    attributes: { type: "object", additionalProperties: true },
                  },
                  required: ["id", "timestamp", "level", "service", "message", "attributes"],
                },
              },
              next_cursor: { type: ["string", "null"] },
            },
            required: ["logs", "next_cursor"],
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseListParams(req.query as Record<string, unknown>);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

      const { filters, limit, cursor } = parsed.value;
      const page = await queryLogs(deps.pool, filters, limit, cursor, tenantOf(req));
      return { logs: page.logs, next_cursor: page.nextCursor };
    }
  );

  // -------------------------------------------------------------------------
  // GET /logs/aggregate — time-bucketed counts
  // -------------------------------------------------------------------------
  app.get(
    "/logs/aggregate",
    {
      onRequest: [auth("query")],
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              buckets: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    start: { type: "string" },
                    group: { type: ["string", "null"] },
                    count: { type: "integer" },
                  },
                  required: ["start", "group", "count"],
                },
              },
            },
            required: ["buckets"],
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseAggregateParams(req.query as Record<string, unknown>);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

      const buckets = await aggregateLogs(deps.pool, parsed.value, tenantOf(req));
      return {
        buckets: buckets.map((b) => ({
          start: b.start.toISOString(),
          group: b.group,
          count: b.count,
        })),
      };
    }
  );
}

