import type { FastifyInstance } from "fastify";

import { registry } from "../metrics";

/**
 * GET /metrics — Prometheus exposition. Internal-only in production (restrict at the
 * reverse proxy / firewall; it isn't authenticated here).
 */
export function registerMetricsRoute(app: FastifyInstance): void {
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
