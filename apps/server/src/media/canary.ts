import type { FastifyBaseLogger } from "fastify";

import type { Config } from "../config";
import { registerLazyMetric, youtubeCanaryLastSuccess, youtubeCanaryOk } from "../metrics";
import { DownloadError } from "./Downloader";
import { validateSource } from "./SourceValidator";

/** Result of the most recent canary probe; ok is null until the first probe completes. */
export interface CanaryState {
  ok: boolean | null;
  lastCheck?: string;
  lastError?: string;
}

/** Delay before the first probe so boot (filler load, entrypoint self-update I/O) settles first. */
const BOOT_DELAY_MS = 60_000;

/**
 * Periodic YouTube canary: a metadata-only probe of a known-stable public video through the
 * real pipeline (same player_client, PO-token sidecar and cookies as user submissions), so
 * extractor breakage — stale yt-dlp after a YouTube-side change — is detected before users
 * report it. Failures log at error level with a stable marker and flip the
 * radio_youtube_canary_ok gauge; /healthz surfaces the state for operators.
 *
 * Deliberately probe-only: no media is downloaded, so a 6-hourly tick is negligible load and
 * indistinguishable from a user pasting a link. Runs through the worker's bounded queue.
 */
export function startYtCanary(
  cfg: Config,
  log: FastifyBaseLogger,
  probe: (canonicalUrl: string) => Promise<void>,
): { stop: () => void; state: () => CanaryState | null } {
  if (cfg.YT_CANARY_INTERVAL_MS === 0) {
    return { stop: () => {}, state: () => null };
  }

  let canonicalUrl: string;
  try {
    canonicalUrl = validateSource(cfg.YT_CANARY_URL).canonicalUrl;
  } catch (err) {
    log.error({ url: cfg.YT_CANARY_URL, err: err instanceof Error ? err.message : String(err) }, "youtube canary: invalid YT_CANARY_URL — canary disabled");
    return { stop: () => {}, state: () => null };
  }

  const state: CanaryState = { ok: null };
  let running = false;

  const tick = async () => {
    if (running) return; // a probe is at most seconds; never stack ticks
    running = true;
    try {
      await probe(canonicalUrl);
      state.ok = true;
      state.lastError = undefined;
      registerLazyMetric(youtubeCanaryOk); // absent until it has an honest value (see metrics.ts)
      registerLazyMetric(youtubeCanaryLastSuccess);
      youtubeCanaryOk.set(1);
      youtubeCanaryLastSuccess.set(Math.floor(Date.now() / 1000));
    } catch (err) {
      state.ok = false;
      state.lastError = err instanceof DownloadError ? `${err.kind}: ${err.message}` : err instanceof Error ? err.message : String(err);
      registerLazyMetric(youtubeCanaryOk);
      youtubeCanaryOk.set(0);
      // Stable marker for log grepping; the kind says whether it's stale-yt-dlp or e.g. bot-check.
      log.error({ url: canonicalUrl, error: state.lastError }, "YOUTUBE CANARY FAILING — YouTube submissions are likely broken for users");
    } finally {
      state.lastCheck = new Date().toISOString();
      running = false;
    }
  };

  const bootTimer = setTimeout(() => void tick(), BOOT_DELAY_MS);
  const timer = setInterval(() => void tick(), cfg.YT_CANARY_INTERVAL_MS);

  return {
    stop: () => {
      clearTimeout(bootTimer);
      clearInterval(timer);
    },
    state: () => ({ ...state }),
  };
}
