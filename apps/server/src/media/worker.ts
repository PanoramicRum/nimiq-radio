import { unlink } from "node:fs/promises";
import path from "node:path";

import PQueue from "p-queue";
import type { FastifyBaseLogger } from "fastify";
import type { QueueItem } from "@radio/shared";

import type { Config } from "../config";
import { downloadFailures } from "../metrics";
import { ContentRejectedError, DownloadError, type Downloader, type DownloadResult, type ProbeInfo } from "./Downloader";
import { evaluateContent } from "./ContentGate";
import { resolveCoverArt } from "./CoverArtResolver";
import { createMusicTagger, type MusicTagger } from "./MusicTagger";
import { validateSource } from "./SourceValidator";
import { YtDlpDownloader } from "./YtDlpDownloader";

/** A successfully downloaded + transcoded track, before it becomes a QueueItem. */
export interface PreparedTrack {
  id: string;
  /** Canonical source URL handed to the downloader. */
  sourceUrl: string;
  /** Public path: /static/tracks/<id>.<ext> */
  trackUrl: string;
  title: string;
  author?: string;
  album?: string;
  duration?: number;
  /** Transient cover-art inputs — used to fetch the cover in the background after enqueue. */
  releaseGroupMbid?: string;
  thumbnailUrl?: string;
  createdAt: string;
}

/**
 * Owns the bounded download queue. The route layer calls prepare(); concurrency is
 * capped by p-queue. The RadioEngine (not the worker) is the registry of queued songs.
 */
export class MediaWorker {
  private readonly queue: PQueue;
  private readonly downloader: Downloader;
  private readonly tagger: MusicTagger;

  constructor(
    private readonly cfg: Config,
    private readonly log: FastifyBaseLogger,
  ) {
    this.queue = new PQueue({ concurrency: cfg.DOWNLOAD_CONCURRENCY });
    this.downloader = new YtDlpDownloader(cfg, log);
    this.tagger = createMusicTagger(cfg, log);
  }

  /**
   * Metadata-only probe through the bounded download queue — used by the YouTube canary.
   * Success = the extractor still works; the probe's temp info-json is discarded.
   * Throws DownloadError (with .kind) on failure.
   */
  async probeOnly(canonicalUrl: string): Promise<void> {
    const info = (await this.queue.add(() => this.downloader.probe(canonicalUrl), {
      throwOnTimeout: true,
    })) as ProbeInfo;
    if (info.infoJsonPath) await unlink(info.infoJsonPath).catch(() => {});
  }

  /**
   * Validate → (gate: probe + reject non-songs BEFORE downloading) → download →
   * correct metadata via fingerprint → return the prepared track.
   * Throws SourceValidationError (bad URL), ContentRejectedError (not a song), DownloadError.
   */
  async prepare(rawUrl: string): Promise<PreparedTrack> {
    const { canonicalUrl, source } = validateSource(rawUrl);

    let infoJsonPath: string | undefined;
    try {
      if (this.cfg.CONTENT_GATE_ENABLED) {
        const info = (await this.queue.add(() => this.downloader.probe(canonicalUrl), {
          throwOnTimeout: true,
        })) as ProbeInfo;
        infoJsonPath = info.infoJsonPath; // reuse this extraction for the download (no 2nd round-trip)
        const decision = evaluateContent(info, this.cfg);
        if (!decision.ok) throw new ContentRejectedError(decision.reason, decision.code);
      }

      const result = (await this.queue.add(() => this.downloader.download(canonicalUrl, { infoJsonPath }), {
        throwOnTimeout: true,
      })) as DownloadResult;

      // Best-effort metadata correction (never throws; keeps yt-dlp values on miss/failure).
      const meta = await this.tagger.tag(result.trackPath, {
        title: result.title,
        author: result.author,
        album: result.album,
        duration: result.duration,
      });

      // Cover art is fetched in the background after enqueue (see attachCoverInBackground), so it
      // never blocks the song from playing. Carry the inputs it needs.
      const ext = path.extname(result.trackPath); // e.g. ".m4a"
      return {
        id: result.id,
        sourceUrl: canonicalUrl,
        trackUrl: `/static/tracks/${result.id}${ext}`,
        title: meta.title,
        author: meta.author,
        album: meta.album,
        duration: meta.duration,
        releaseGroupMbid: meta.releaseGroupMbid,
        thumbnailUrl: result.thumbnail,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      // Per-source failure metric: a rising youtube/extractor_stale series while soundcloud
      // stays clean is exactly the "yt-dlp needs an update" signature.
      if (err instanceof DownloadError) {
        downloadFailures.inc({ source, kind: err.kind });
      }
      throw err;
    } finally {
      if (infoJsonPath) await unlink(infoJsonPath).catch(() => {});
    }
  }
}

/**
 * Fetch + cache album art in the background, then patch it onto the already-enqueued song.
 * Best-effort and fire-and-forget: a failure leaves the song playing without a cover, and a
 * success triggers a state re-broadcast so clients update. Call AFTER the item is enqueued.
 */
export function attachCoverInBackground(
  engine: { setCoverUrl(id: string, coverUrl: string): void },
  cfg: Config,
  log: FastifyBaseLogger,
  trackId: string,
  inputs: { releaseGroupMbid?: string; thumbnailUrl?: string },
): void {
  void resolveCoverArt(cfg, log, { id: trackId, releaseGroupMbid: inputs.releaseGroupMbid, thumbnailUrl: inputs.thumbnailUrl })
    .then((coverUrl) => {
      if (coverUrl) engine.setCoverUrl(trackId, coverUrl);
    })
    .catch(() => {
      /* resolveCoverArt already swallows its own errors; this is belt-and-suspenders */
    });
}

/** Map a freshly prepared track into a queue item (free + unattributed in Phase 2). */
export function toQueueItem(track: PreparedTrack): QueueItem {
  return {
    id: track.id,
    sourceUrl: track.sourceUrl,
    trackUrl: track.trackUrl,
    title: track.title,
    author: track.author,
    album: track.album,
    duration: track.duration,
    submittedBy: undefined,
    amountPaid: 0,
    createdAt: track.createdAt,
    status: "ready",
  };
}
