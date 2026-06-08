import type { FastifyInstance } from "fastify";

import type { RadioEngine } from "../engine/RadioEngine";

/** GET /api/state — the current server-authoritative radio snapshot (polled by clients). */
export function registerStateRoute(app: FastifyInstance, engine: RadioEngine): void {
  app.get("/api/state", async () => engine.snapshot());
}
