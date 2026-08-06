import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import type { IngestWriter } from "./services/ingestWriter.js";
import { registerLogRoutes } from "./routes/logs.js";
import { registerHealthRoute } from "./routes/health.js";

/**
 * Application factory. Everything is passed in as arguments — no global
 * state, no config/db singletons — so tests can build the app against a
 * real pool and the HTTP layer stays pure.
 */

export interface AppContext {
  config: Config;
  pool: Pool;
  writer: IngestWriter;
  ready: { isReady(): boolean };
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({
    // Per-request logging at 15k req/s would burn CPU for little value.
    // NOTE: deprecated in fastify 6 in favor of logger.logController;
    // logController isn't in the v5 public types yet, so we use the
    // top-level flag (valid in fastify ^5, which we pin).
    disableRequestLogging: true,
    logger: { level: ctx.config.logLevel },
    // Generous body limit: batches may be several MB in the load test.
    bodyLimit: 16 * 1024 * 1024,
    requestTimeout: 30_000,
    // allowUnionTypes silences Ajv strict-mode warnings for
    // `type: ["string", "null"]` in response schemas.
    ajv: { customOptions: { allowUnionTypes: true } },
  });

  // Uniform 400 shape for contract-specified failures:
  // malformed JSON / wrong structure must answer {"error": ...}, not the
  // default Fastify error payload.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.statusCode === 400) {
      if (
        err.code === "FST_ERR_CTP_INVALID_JSON" ||
        err.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
      ) {
        return reply.code(400).send({ error: "malformed JSON body" });
      }
      return reply.code(400).send({ error: err.message ?? "bad request" });
    }
    reply.send(err);
  });

  // Accept JSON regardless of the Content-Type header. The load generator is
  // a generic client; some HTTP stacks omit Content-Type when posting JSON.
  // Fastify's "*" parser is a fallback: specific parsers (application/json,
  // and text/plain below — some clients send JSON as text/plain) take
  // precedence. A body that is not valid JSON becomes a 400 "malformed JSON
  // body" via the error handler.
  const jsonParser = (_req: unknown, body: string, done: (err: Error | null, parsed?: unknown) => void): void => {
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Route parse failures through the same 400 "malformed JSON body" path
      // as Fastify's own JSON parser errors.
      (e as Error & { code?: string; statusCode?: number }).code = "FST_ERR_CTP_INVALID_JSON";
      (e as Error & { code?: string; statusCode?: number }).statusCode = 400;
      done(e, undefined);
    }
  };
  app.addContentTypeParser("text/plain", { parseAs: "string" }, jsonParser);
  app.addContentTypeParser("*", { parseAs: "string" }, jsonParser);

  registerHealthRoute(app, ctx.ready);
  registerLogRoutes(app, {
    config: ctx.config,
    pool: ctx.pool,
    writer: ctx.writer,
  });

  return app;
}
