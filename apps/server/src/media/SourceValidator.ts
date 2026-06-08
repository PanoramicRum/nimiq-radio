/**
 * Validates and canonicalizes user-submitted media URLs.
 *
 * Security posture (plan §SSRF / Phase 1):
 *  - parse with the WHATWG URL parser (never regex on the raw string),
 *  - require https,
 *  - exact host allowlist,
 *  - extract the 11-char video id and REBUILD a canonical URL that is handed to
 *    yt-dlp — the raw user input is never passed downstream.
 *
 * This is the swappable "source" seam: adding SoundCloud/etc. later means adding
 * another validator behind the same interface, not touching the downloader.
 */

export class SourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceValidationError";
  }
}

export interface ValidatedSource {
  /** Canonical URL safe to hand to the downloader. */
  canonicalUrl: string;
  videoId: string;
  source: "youtube";
}

const ALLOWED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PATH_ID_RE = /^\/(shorts|embed|live|v)\/([^/?#]+)/;

export function validateSource(rawUrl: string): ValidatedSource {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceValidationError("Not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new SourceValidationError("Only https:// URLs are allowed.");
  }

  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new SourceValidationError(`Host not allowed: ${host}. Only YouTube links are supported.`);
  }

  const videoId = extractVideoId(url, host);
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    throw new SourceValidationError("Could not find a valid YouTube video id in that URL.");
  }

  return {
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    source: "youtube",
  };
}

function extractVideoId(url: URL, host: string): string | null {
  if (host === "youtu.be") {
    // https://youtu.be/<id>
    return url.pathname.slice(1).split("/")[0] || null;
  }
  // youtube.com family
  if (url.pathname === "/watch") {
    return url.searchParams.get("v");
  }
  const m = url.pathname.match(PATH_ID_RE);
  if (m) return m[2] ?? null;
  return null;
}
