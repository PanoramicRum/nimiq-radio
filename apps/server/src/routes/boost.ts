import type { BoostIntentResponse, BoostResponse } from "@radio/shared";
import { BoostBody } from "@radio/shared";
import type { FastifyInstance } from "fastify";

import { config } from "../config";
import type { RadioEngine } from "../engine/RadioEngine";
import { paymentsVerified } from "../metrics";
import type { BoostRegistry } from "../payments/BoostRegistry";
import type { PaymentsStore } from "../payments/PaymentsStore";
import type { PaymentVerifier } from "../payments/PaymentVerifier";

/**
 * Boosting an existing queued song (Phase 4).
 *  - GET  /api/boost-intent?queueItemId=...  -> issues an order id + minimum price.
 *  - POST /api/boost { boostId, sdkResult }   -> verifies payment, adds the on-chain amount
 *    to the song's total, and reorders the upcoming queue. The now-playing track is never
 *    preempted; a song that already left the queue returns "gone".
 */
export function registerBoostRoutes(
  app: FastifyInstance,
  deps: { engine: RadioEngine; registry: BoostRegistry; verifier: PaymentVerifier; payments: PaymentsStore },
): void {
  app.get("/api/boost-intent", async (request, reply) => {
    if (!config.paymentsEnabled) {
      return reply.status(404).send({ success: false, error: "Payments are disabled." } satisfies BoostIntentResponse);
    }
    const queueItemId = (request.query as { queueItemId?: string }).queueItemId;
    if (!queueItemId) {
      return reply.status(400).send({ success: false, error: "queueItemId is required." } satisfies BoostIntentResponse);
    }

    const snapshot = deps.engine.snapshot();
    const inQueue = snapshot.queue.some((q) => q.id === queueItemId);
    if (!inQueue) {
      const reason = snapshot.current?.id === queueItemId ? "The now-playing song can't be boosted." : "That song is no longer in the queue.";
      return reply.status(400).send({ success: false, error: reason } satisfies BoostIntentResponse);
    }

    const record = deps.registry.create(queueItemId, config.priceLuna);
    return reply.send({
      success: true,
      boostId: record.boostId,
      orderId: record.orderId,
      minLuna: record.minLuna,
      recipientAddress: config.recipientAddress as string,
      queueItemId,
    } satisfies BoostIntentResponse);
  });

  app.post(
    "/api/boost",
    { config: { rateLimit: { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      if (!config.paymentsEnabled) {
        return reply.status(404).send({ success: false, code: "disabled", error: "Payments are disabled." } satisfies BoostResponse);
      }
      const parsed = BoostBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, code: "error", error: "Body must be { boostId, sdkResult }." } satisfies BoostResponse);
      }
      const { boostId, sdkResult } = parsed.data;

      const record = deps.registry.get(boostId);
      if (!record) {
        return reply.status(404).send({ success: false, code: "expired", error: "This boost session expired. Please try again." } satisfies BoostResponse);
      }

      const result = await deps.verifier.verify({ sdkResult, orderId: record.orderId, requiredLuna: record.minLuna });
      if (!result.ok) {
        const status = result.code === "pending" || result.code === "not_found" ? 202 : 400;
        return reply.status(status).send({ success: false, code: result.code, error: result.reason } satisfies BoostResponse);
      }

      if (deps.payments.isConsumed(result.txHash, record.orderId)) {
        return reply.status(409).send({ success: false, code: "replay", error: "This payment was already used." } satisfies BoostResponse);
      }

      // Apply the boost first (engine.boost persists), then ALWAYS record the payment — even
      // when the song already left the queue ("gone"), so the on-chain tx can never be reused.
      const applied = deps.engine.boost(record.queueItemId, result.payment.amountLuna);
      deps.payments.record({
        txHash: result.txHash,
        orderId: record.orderId,
        trackId: record.queueItemId,
        kind: "boost",
        senderAddress: result.payment.senderAddress,
        recipientAddress: result.payment.recipientAddress,
        amountLuna: result.payment.amountLuna,
      });
      deps.registry.consume(boostId);

      if (applied.applied === "gone" || !applied.item) {
        return reply
          .status(409)
          .send({ success: false, code: "gone", error: "That song already played, so the boost could not be applied." } satisfies BoostResponse);
      }

      paymentsVerified.inc({ kind: "boost" });
      request.log.info({ id: record.queueItemId, amountLuna: result.payment.amountLuna, where: applied.applied }, "boost: applied");
      return reply.send({ success: true, item: applied.item } satisfies BoostResponse);
    },
  );
}
