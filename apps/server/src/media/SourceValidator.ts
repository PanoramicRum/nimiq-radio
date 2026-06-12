/**
 * Validates and canonicalizes user-submitted media URLs.
 *
 * Security posture (plan §SSRF / Phase 1):
 *  - parse with the WHATWG URL parser (never regex on the raw string),
 *  - require https,
 *  - exact / pattern host allowlist,
 *  - validate the path SHAPE, then REBUILD a clean canonical URL (no query, fragment, or
 *    credentials) that is handed to yt-dlp — the raw user input is never passed downstream.
 *
 * This is the swappable "source" seam. yt-dlp handles YouTube, SoundCloud, Bandcamp and Audius, so
 * adding another supported site is another branch here, not a downloader change.
 */

export class SourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceValidationError";
  }
}

export type Source = "youtube" | "soundcloud" | "bandcamp" | "audius";

export interface ValidatedSource {
  /** Canonical URL safe to hand to the downloader (query / fragment / credentials stripped). */
  canonicalUrl: string;
  source: Source;
}

const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "m.soundcloud.com"]);

const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_PATH_ID_RE = /^\/(shorts|embed|live|v)\/([^/?#]+)/;
/** <user>/<track> — exactly two path segments, so sets/playlists (3+ segments) are rejected. */
const SOUNDCLOUD_PATH_RE = /^\/([\w-]+)\/([\w-]+)$/;
/** /track/<slug> on an <artist>.bandcamp.com subdomain (rejects /album/... and bare hosts). */
const BANDCAMP_PATH_RE = /^\/track\/([\w-]+)$/;
const BANDCAMP_SUB_RE = /^[a-z0-9][a-z0-9-]*$/;
/** <handle>/<slug> — a single track; rejects /<handle>/playlist/<slug> and bare profiles. */
const AUDIUS_PATH_RE = /^\/([\w.-]+)\/([\w-]+)$/;

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

  if (YOUTUBE_HOSTS.has(host)) {
    const videoId = extractYouTubeId(url, host);
    if (!videoId || !YT_VIDEO_ID_RE.test(videoId)) {
      throw new SourceValidationError("Could not find a valid YouTube video id in that URL.");
    }
    return { canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`, source: "youtube" };
  }

  if (SOUNDCLOUD_HOSTS.has(host)) {
    const m = url.pathname.match(SOUNDCLOUD_PATH_RE);
    if (!m) throw new SourceValidationError("Link a single SoundCloud track (sets/playlists aren't supported).");
    return { canonicalUrl: `https://soundcloud.com/${m[1]}/${m[2]}`, source: "soundcloud" };
  }

  if (host.endsWith(".bandcamp.com")) {
    const sub = host.slice(0, -".bandcamp.com".length);
    if (!BANDCAMP_SUB_RE.test(sub)) throw new SourceValidationError("Unrecognized Bandcamp host.");
    const m = url.pathname.match(BANDCAMP_PATH_RE);
    if (!m) throw new SourceValidationError("Link a single Bandcamp track (album links aren't supported).");
    return { canonicalUrl: `https://${host}/track/${m[1]}`, source: "bandcamp" };
  }

  if (host === "audius.co") {
    const m = url.pathname.match(AUDIUS_PATH_RE);
    if (!m) throw new SourceValidationError("Link a single Audius track (playlists/profiles aren't supported).");
    return { canonicalUrl: `https://audius.co/${m[1]}/${m[2]}`, source: "audius" };
  }

  throw new SourceValidationError(`Host not allowed: ${host}. Supported: YouTube, SoundCloud, Bandcamp, Audius.`);
}

function extractYouTubeId(url: URL, host: string): string | null {
  if (host === "youtu.be") {
    // https://youtu.be/<id>
    return url.pathname.slice(1).split("/")[0] || null;
  }
  // youtube.com family
  if (url.pathname === "/watch") {
    return url.searchParams.get("v");
  }
  const m = url.pathname.match(YT_PATH_ID_RE);
  if (m) return m[2] ?? null;
  return null;
}
