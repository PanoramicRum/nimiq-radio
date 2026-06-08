import type { FastifyInstance } from "fastify";
import { PrepareSongBody, type PrepareSongResponse } from "@radio/shared";

import { config } from "../config";
import type { RadioEngine } from "../engine/RadioEngine";
import { ContentRejectedError, DownloadError } from "../media/Downloader";
import { SourceValidationError } from "../media/SourceValidator";
import { attachCoverInBackground, toQueueItem, type MediaWorker } from "../media/worker";
import { songsPrepared, songsRejected } from "../metrics";
import type { PrepareRegistry } from "../payments/PrepareRegistry";

/**
 * POST /api/prepare-song { url }
 *
 * Downloads + transcodes (bounded by the p-queue), then:
 *  - free mode (no RECIPIENT_ADDRESS): enqueue immediately and return mode:"free".
 *  - paid mode: DO NOT enqueue — stage the track, return a prepareId + orderId + price so
 *    the client can pay, then call POST /api/submit. A failed download never reaches payment.
 */
export function registerPrepareRoute(
  app: FastifyInstance,
  deps: { worker: MediaWorker; engine: RadioEngine; registry: PrepareRegistry },
): void {
  app.post(
    "/api/prepare-song",
    { config: { rateLimit: { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
    const parsed = PrepareSongBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "Request body must be { url: <valid URL> }." } satisfies PrepareSongResponse);
    }

    try {
      const track = await deps.worker.prepare(parsed.data.url);
      songsPrepared.inc();

      if (!config.paymentsEnabled) {
        deps.engine.enqueue(toQueueItem(track));
        // Fetch the cover in the background and patch it onto the enqueued song (non-blocking).
        attachCoverInBackground(deps.engine, config, request.log, track.id, {
          releaseGroupMbid: track.releaseGroupMbid,
          thumbnailUrl: track.thumbnailUrl,
        });
        return reply.send({
          success: true,
          mode: "free",
          trackUrl: track.trackUrl,
          title: track.title,
          author: track.author,
          album: track.album,
          duration: track.duration,
        } satisfies PrepareSongResponse);
      }

      const record = deps.registry.create(track, config.priceLuna);
      return reply.send({
        success: true,
        mode: "paid",
        prepareId: record.prepareId,
        orderId: record.orderId,
        priceLuna: record.priceLuna,
        recipientAddress: config.recipientAddress as string,
        trackUrl: track.trackUrl,
        title: track.title,
        author: track.author,
        album: track.album,
        duration: track.duration,
      } satisfies PrepareSongResponse);
    } catch (err) {
      if (err instanceof SourceValidationError) {
        return reply.status(400).send({ success: false, error: err.message } satisfies PrepareSongResponse);
      }
      if (err instanceof ContentRejectedError) {
        songsRejected.inc({ reason: err.code });
        request.log.info({ reason: err.code }, "prepare-song: content rejected");
        return reply.status(422).send({ success: false, error: err.message } satisfies PrepareSongResponse);
      }
      if (err instanceof DownloadError) {
        request.log.warn({ err: err.message }, "prepare-song: download failed");
        return reply.status(502).send({ success: false, error: err.message } satisfies PrepareSongResponse);
      }
      request.log.error({ err }, "prepare-song: unexpected error");
      return reply.status(500).send({ success: false, error: "Internal error preparing the song." } satisfies PrepareSongResponse);
    }
  });
}
