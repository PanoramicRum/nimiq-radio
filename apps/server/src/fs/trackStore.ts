import path from "node:path";

/**
 * Path-traversal-safe mapping from an opaque track id to its MP3 file.
 *
 * @fastify/static already blocks traversal on the /static/tracks route, but this
 * helper is the single source of truth for id validation and is reused by cleanup
 * (Phase 6) and any future manual/ signed-URL serving. Defense in depth.
 */

const TRACK_ID_RE = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Audio container extensions we serve + clean up. m4a is the default output; mp3 is kept for
 * tracks downloaded before the native-audio change, and webm/opus/ogg/aac cover the rare
 * re-encode fallback or alternate sources.
 */
export const AUDIO_EXTS = new Set([".mp3", ".m4a", ".webm", ".opus", ".ogg", ".aac"]);

/** True if `name` ends in a known audio extension (case-insensitive). */
export function isAudioFilename(name: string): boolean {
  return AUDIO_EXTS.has(path.extname(name).toLowerCase());
}

export function isValidTrackId(id: string): boolean {
  return TRACK_ID_RE.test(id);
}

export function resolveTrackPath(tracksDir: string, id: string): string {
  if (!isValidTrackId(id)) {
    throw new Error(`Invalid track id: ${id}`);
  }
  const base = path.resolve(tracksDir);
  const resolved = path.resolve(base, `${id}.mp3`);
  // "check for ../ is not enough" — assert the resolved path stays inside base.
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}
