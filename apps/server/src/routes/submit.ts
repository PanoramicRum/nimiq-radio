import { existsSync } from "node:fs";
import path from "node:path";

import type { QueueItem, SubmitResponse } from "@radio/shared";
import { SubmitBody } from "@radio/shared";
import type { FastifyInstance } from "fastify";

import { config } from "../config";
import type { RadioEngine } from "../engine/RadioEngine";
import { attachCoverInBackground, toQueueItem, type MediaWorker } from "../media/worker";
import { paymentsVerified } from "../metrics";
import type { PaymentsStore } from "../payments/PaymentsStore";
import type { PaymentVerifier } from "../payments/PaymentVerifier";
import type { PrepareRegistry } from "../payments/PrepareRegistry";

/**
 * POST /api/submit { prepareId, sdkResult }  (paid mode only)
 *
 * Verifies the payment on-chain, blocks replays, then enqueues the song with the on-chain
 * sender + amount. "pending" (not yet confirmed) returns 202 so the client retries.
 */
export function registerSubmitRoute(
  app: FastifyInstance,
  deps: {
    engine: RadioEngine;
    registry: PrepareRegistry;
    verifier: PaymentVerifier;
    payments: PaymentsStore;
    worker: MediaWorker;
  },
): void {
  app.post(
    "/api/submit",
    { config: { rateLimit: { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
    if (!config.paymentsEnabled) {
      return reply.status(404).send({ success: false, code: "error", error: "Payments are disabled." } satisfies SubmitResponse);
    }

    const parsed = SubmitBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, code: "error", error: "Body must be { prepareId, sdkResult }." } satisfies SubmitResponse);
    }
    const { prepareId, sdkResult } = parsed.data;

    const record = deps.registry.get(prepareId);
    if (!record) {
      return reply
        .status(404)
        .send({ success: false, code: "expired", error: "This song's payment session expired. Please add it again." } satisfies SubmitResponse);
    }

    const result = await deps.verifier.verify({ sdkResult, orderId: record.orderId, requiredLuna: record.priceLuna });
    if (!result.ok) {
      const status = result.code === "pending" || result.code === "not_found" ? 202 : 400;
      return reply.status(status).send({ success: false, code: result.code, error: result.reason } satisfies SubmitResponse);
    }

    if (deps.payments.isConsumed(result.txHash, record.orderId)) {
      return reply.status(409).send({ success: false, code: "replay", error: "This payment was already used." } satisfies SubmitResponse);
    }

    // Do all the (async, fallible) work to obtain a playable track BEFORE recording the
    // payment, so the durable "consumed" mark is only written once the song is safely
    // enqueued + persisted. Safety net: if the staged MP3 is gone (cleanup / disk eviction),
    // re-download by the canonical source so a paid user never gets nothing.
    let track = record.track;
    // Extension-agnostic: the staged track records its own filename in trackUrl (<id>.<ext>).
    const filePath = path.join(config.TRACKS_DIR, path.basename(track.trackUrl));
    if (!existsSync(filePath)) {
      request.log.warn({ id: track.id }, "submit: staged file missing, re-downloading");
      try {
        track = await deps.worker.prepare(track.sourceUrl);
      } catch (err) {
        request.log.error({ err }, "submit: re-download failed after payment");
        // Not recorded yet -> the user can retry the same tx once the issue clears.
        return reply
          .status(500)
          .send({ success: false, code: "error", error: "Payment received but the audio could not be re-prepared. Please try again shortly." } satisfies SubmitResponse);
      }
    }

    const item: QueueItem = {
      ...toQueueItem(track),
      submittedBy: result.payment.senderAddress,
      amountPaid: result.payment.amountLuna,
    };
    // enqueue (persists the song) then record the payment — these are synchronous and
    // adjacent, so the song is durable before the tx is marked consumed.
    deps.engine.enqueue(item);
    // Fetch the cover in the background and patch it onto the enqueued song (non-blocking).
    attachCoverInBackground(deps.engine, config, request.log, item.id, {
      releaseGroupMbid: track.releaseGroupMbid,
      thumbnailUrl: track.thumbnailUrl,
    });
    deps.payments.record({
      txHash: result.txHash,
      orderId: record.orderId,
      trackId: item.id,
      kind: "submit",
      senderAddress: result.payment.senderAddress,
      recipientAddress: result.payment.recipientAddress,
      amountLuna: result.payment.amountLuna,
    });
    deps.registry.consume(prepareId);
    paymentsVerified.inc({ kind: "submit" });

    request.log.info({ id: item.id, amountLuna: item.amountPaid, from: item.submittedBy }, "submit: enqueued paid song");
    return reply.send({ success: true, queued: item } satisfies SubmitResponse);
  });
}
