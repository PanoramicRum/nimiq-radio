import type { FastifyInstance } from "fastify";

import type { CanaryState } from "../media/canary";

/**
 * GET /healthz — liveness plus operator diagnostics. Top-level status stays "ok"
 * unconditionally: a YouTube-side outage must never fail container/proxy healthchecks.
 * The youtube block (from the canary; omitted when the canary is disabled) tells an
 * operator whether YouTube submissions currently work. Internal-only in prod: the
 * nginx web tier proxies /api, /static and /ws — not /healthz.
 */
export function registerHealthRoute(app: FastifyInstance, deps: { youtube?: () => CanaryState | null } = {}): void {
  app.get("/healthz", async () => {
    const youtube = deps.youtube?.() ?? null;
    return { status: "ok" as const, ...(youtube ? { youtube } : {}) };
  });
}
