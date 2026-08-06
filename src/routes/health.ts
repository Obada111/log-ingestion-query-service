import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * GET /health — readiness probe.
 *
 * The contract: the service must only report healthy AFTER the database is
 * connected and migrations are applied. The app factory is only built after
 * waitForDatabase() + runMigrations() succeed, and `ready` flips true after
 * listen() — so a 200 here is a true "accepting traffic" signal. Auth is
 * never required here, by contract.
 */
export function registerHealthRoute(app: FastifyInstance, ready: { isReady(): boolean }): void {
  app.get("/health", async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!ready.isReady()) {
      return reply.code(503).send({ status: "starting" });
    }
    return { status: "ok" };
  });
}
