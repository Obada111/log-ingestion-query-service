import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { lookupApiKey } from "./keys.js";

/**
 * Authentication hook factory.
 *
 * Contract rules implemented here:
 *  - AUTH_ENABLED=false (default): credentials in the header are IGNORED —
 *    the load generator always sends a Bearer token and the unauthenticated
 *    core service must keep working.
 *  - GET /health is always exempt (it is registered without this hook).
 *  - Missing/malformed credential        -> 401 {"error": ...}
 *  - Unknown key                         -> 401 {"error": ...}
 *  - Valid key, insufficient scope       -> 403 {"error": ...}
 *  - Transport: Authorization: Bearer, plus X-API-Key as a convenience.
 */

export type RequiredScope = "ingest" | "query";

export interface AuthContext {
  scopes: string[];
  tenantId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

const MAX_KEY_LENGTH = 512;

export function createAuthHook(pool: Pool, config: Config, requiredScope: RequiredScope) {
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    if (!config.authEnabled) return; // auth off: ignore credentials entirely

    const header = req.headers.authorization;
    let key: string | undefined;
    if (header !== undefined && header.startsWith("Bearer ")) {
      key = header.slice("Bearer ".length).trim();
    } else {
      const apiKey = req.headers["x-api-key"];
      key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    }

    if (key === undefined || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      return reply.code(401).send({ error: "missing or malformed credentials" });
    }

    const info = await lookupApiKey(pool, key);
    if (info === null) {
      return reply.code(401).send({ error: "invalid api key" });
    }
    if (!info.scopes.includes(requiredScope)) {
      return reply.code(403).send({ error: `insufficient permissions: scope '${requiredScope}' required` });
    }

    req.authContext = { scopes: info.scopes, tenantId: info.tenantId };
  };
}
