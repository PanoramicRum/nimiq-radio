/**
 * The swappable media-source seam. Phase 1 ships YtDlpDownloader; later phases can
 * add CobaltDownloader or other sources behind this same interface without touching
 * the worker/route layer.
 */

export interface DownloadResult {
  /** Opaque server-generated id; also the filename stem (<id>.<ext>). */
  id: string;
  /** Absolute path to the produced audio file on disk (extension per AUDIO_FORMAT). */
  trackPath: string;
  title: string;
  author?: string;
  album?: string;
  /** Seconds. */
  duration?: number;
  thumbnail?: string;
}

/** Cheap, metadata-only info used by the content gate BEFORE downloading media. */
export interface ProbeInfo {
  duration?: number; // seconds
  isLive?: boolean;
  categories?: string[]; // e.g. ["Music"]
  title?: string;
  track?: string;
  artist?: string;
  album?: string;
  uploader?: string;
  /**
   * Path to the saved info-dict JSON from the probe's extraction. Passing it back to
   * download() (via --load-info-json) lets the download reuse this extraction instead of
   * hitting YouTube a second time. Caller owns deleting it.
   */
  infoJsonPath?: string;
}

export interface Downloader {
  /** Fetch metadata only (no media) so non-songs can be rejected before downloading. */
  probe(canonicalUrl: string, opts?: { signal?: AbortSignal }): Promise<ProbeInfo>;
  /** opts.infoJsonPath: reuse a prior probe's extraction (skips a 2nd YouTube round-trip). */
  download(canonicalUrl: string, opts?: { signal?: AbortSignal; infoJsonPath?: string }): Promise<DownloadResult>;
}

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

/** Thrown when a URL is valid but the content isn't an acceptable song (gate rejection). */
export type ContentRejectCode = "live" | "too_short" | "too_long" | "category";
export class ContentRejectedError extends Error {
  constructor(
    message: string,
    readonly code: ContentRejectCode,
  ) {
    super(message);
    this.name = "ContentRejectedError";
  }
}
