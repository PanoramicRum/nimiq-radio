import type { AppConfig } from "@radio/shared";
import type { FastifyInstance } from "fastify";

import { config } from "../config";

/** GET /api/config — public-safe runtime config so the SPA can pick free vs paid flow. */
export function registerConfigRoute(app: FastifyInstance): void {
  app.get("/api/config", async (): Promise<AppConfig> => ({
    paymentsEnabled: config.paymentsEnabled,
    network: config.NIMIQ_NETWORK,
    recipientAddress: config.recipientAddress ?? null,
    priceLuna: config.priceLuna,
    minConfirmations: config.MIN_CONFIRMATIONS,
  }));
}
