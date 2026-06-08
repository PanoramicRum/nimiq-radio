import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type { Config } from "../config";
import { isValidTrackId } from "../fs/trackStore";
import { coverErrors, coversResolved } from "../metrics";

const USER_AGENT = "NimiqRadio/0.1 (https://github.com/nimiq)";
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepted image content-types → file extension. Anything else is rejected. */
const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface CoverInput {
  /** Opaque track id; also the cover filename stem (<id>.<ext>). */
  id: string;
  /** Release-group MBID from AcoustID (preferred: true square album art). */
  releaseGroupMbid?: string;
  /** yt-dlp thumbnail URL (fallback when there's no album art). */
  thumbnailUrl?: string;
}

/** A successfully downloaded candidate image, staged at a per-source temp path. */
interface Fetched {
  ext: string;
  tempPath: string;
}

/**
 * Best-effort album cover art. The Cover Art Archive (true album art) and the yt-dlp
 * thumbnail are fetched CONCURRENTLY; CAA is preferred, but because the thumbnail downloads
 * in parallel the fallback is ready the instant CAA gives up — a slow/missing CAA never adds
 * sequential latency. Stores the winner at TRACKS_DIR/covers/<id>.<ext>.
 *
 * Returns the public path ("/static/covers/<id>.<ext>") or undefined. MUST NEVER THROW —
 * cover art is enrichment and must never block a song from playing.
 */
export async function resolveCoverArt(cfg: Config, log: FastifyBaseLogger, input: CoverInput): Promise<string | undefined> {
  try {
    if (!cfg.COVER_ENABLED) return undefined;
    if (!isValidTrackId(input.id)) return undefined; // defense in depth: keeps the path safe

    const dir = path.join(cfg.TRACKS_DIR, "covers");
    const caaUrl =
      input.releaseGroupMbid && MBID_RE.test(input.releaseGroupMbid)
        ? `https://coverartarchive.org/release-group/${input.releaseGroupMbid}/front-${cfg.COVER_SIZE}`
        : undefined;
    const thumbUrl = input.thumbnailUrl && /^https:\/\//i.test(input.thumbnailUrl) ? input.thumbnailUrl : undefined;

    // Kick off both downloads at once (each to its own temp file — no clobber).
    const caaP = caaUrl ? fetchToTemp(cfg, log, dir, input.id, "caa", caaUrl) : Promise.resolve(undefined);
    const thumbP = thumbUrl ? fetchToTemp(cfg, log, dir, input.id, "thumb", thumbUrl) : Promise.resolve(undefined);

    // Prefer CAA: wait for its verdict; the thumbnail is already downloading concurrently.
    const caa = await caaP;
    if (caa) {
      void thumbP.then((t) => t && unlink(t.tempPath).catch(() => {})); // discard the loser's temp
      return commit(dir, input.id, caa, "caa", log);
    }
    const thumb = await thumbP;
    if (thumb) return commit(dir, input.id, thumb, "thumbnail", log);

    return undefined; // neither source yielded an image — song still plays, no cover
  } catch (err) {
    coverErrors.inc();
    log.debug({ err: err instanceof Error ? err.message : String(err) }, "cover: resolver failed");
    return undefined;
  }
}

/** Move the winning temp file into its final <id>.<ext> name and return the public path. */
async function commit(dir: string, id: string, f: Fetched, source: "caa" | "thumbnail", log: FastifyBaseLogger): Promise<string | undefined> {
  try {
    await rename(f.tempPath, path.join(dir, `${id}.${f.ext}`));
  } catch {
    await unlink(f.tempPath).catch(() => {});
    return undefined;
  }
  coversResolved.inc({ source });
  log.info({ id, source }, "cover: stored");
  return `/static/covers/${id}.${f.ext}`;
}

/** Fetch one candidate into a per-source temp file. Returns its ext + path, or undefined. Never throws. */
async function fetchToTemp(
  cfg: Config,
  log: FastifyBaseLogger,
  dir: string,
  id: string,
  label: "caa" | "thumb",
  url: string,
): Promise<Fetched | undefined> {
  try {
    // Native fetch follows the Cover Art Archive 307 redirect (to archive.org) by default.
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "image/*" },
      signal: AbortSignal.timeout(cfg.COVER_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) return undefined; // 404 = no art for this release; 5xx = skip

    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) return undefined; // not an image (e.g. an HTML error page) — don't save it

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cfg.COVER_MAX_BYTES) return undefined;

    const buf = await readCapped(res.body, cfg.COVER_MAX_BYTES);
    if (!buf || buf.length === 0) return undefined; // oversized or empty

    await mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `${id}.${label}.part`);
    await writeFile(tempPath, buf);
    return { ext, tempPath };
  } catch (err) {
    coverErrors.inc(); // thrown only on timeout / network error (a clean 404 returns above)
    log.debug({ err: err instanceof Error ? err.message : String(err), url }, "cover: candidate failed");
    return undefined;
  }
}

/** Read a web stream into a Buffer, aborting (returns null) once it exceeds max bytes. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
