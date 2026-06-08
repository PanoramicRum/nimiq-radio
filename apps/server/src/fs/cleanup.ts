import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type { Config } from "../config";
import { isAudioFilename, isValidTrackId } from "./trackStore";

/** Provides the set of track ids that must never be deleted (current, queued, staged-unpaid). */
export type PinnedIdsFn = () => Set<string>;

/** Files modified within this window are never LRU-evicted (protects in-flight/just-staged downloads). */
const GRACE_MS = 5 * 60_000;

interface FileInfo {
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Periodic temp-file cleanup (Phase 6):
 *  1. delete MP3s older than FILE_TTL_MIN (this also reaps already-played tracks),
 *  2. if total MP3 bytes exceed DISK_CAP_MB, LRU-evict oldest until under the cap.
 * Pinned ids (now-playing, queued, and staged-but-unpaid) are never deleted. Returns a
 * stop() to clear the timer.
 */
/** One cleanup pass against the given pinned set. Exported for testing. */
export async function runCleanupSweep(cfg: Config, log: FastifyBaseLogger, pinned: Set<string>): Promise<void> {
  const dir = path.resolve(cfg.TRACKS_DIR);
  const coversDir = path.join(dir, "covers");
  const ttlMs = cfg.FILE_TTL_MIN * 60_000;
  const capBytes = cfg.DISK_CAP_MB * 1024 * 1024;

  async function tryDelete(p: string, id: string): Promise<boolean> {
    try {
      await unlink(p);
      log.info({ id }, "cleanup: deleted temp track");
      // Remove the cover alongside its mp3 (covers are tiny and not disk-cap-counted).
      await deleteCover(coversDir, id);
      return true;
    } catch {
      return false;
    }
  }

  {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    const now = Date.now();

    const infos: FileInfo[] = [];
    for (const name of entries) {
      if (!isAudioFilename(name)) continue; // never touch radio.db / WAL / covers/ / others
      const id = path.parse(name).name; // stem without extension (handles .mp3 / .m4a / .webm …)
      if (!isValidTrackId(id)) continue;
      const p = path.join(dir, name);
      try {
        const s = await stat(p);
        infos.push({ id, path: p, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        /* vanished between readdir and stat */
      }
    }

    // 1) TTL eviction (skip pinned).
    const survivors: FileInfo[] = [];
    for (const info of infos) {
      if (!pinned.has(info.id) && now - info.mtimeMs > ttlMs) {
        await tryDelete(info.path, info.id);
      } else {
        survivors.push(info);
      }
    }

    // 2) Disk-cap LRU eviction (skip pinned), oldest first. Never evict very recent files:
    // a just-finished download may not be pinned yet (the brief window before it's staged in
    // the registry or enqueued), and we must not delete it out from under a paying user.
    let total = survivors.reduce((sum, f) => sum + f.size, 0);
    if (total > capBytes) {
      const evictable = survivors
        .filter((f) => !pinned.has(f.id) && now - f.mtimeMs > GRACE_MS)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const info of evictable) {
        if (total <= capBytes) break;
        if (await tryDelete(info.path, info.id)) total -= info.size;
      }
      if (total > capBytes) {
        log.warn({ totalMb: Math.round(total / 1024 / 1024), capMb: cfg.DISK_CAP_MB }, "cleanup: still over disk cap (all remaining files are pinned)");
      }
    }
  }
}

/** Best-effort removal of a track's cover art (any accepted extension). */
async function deleteCover(coversDir: string, id: string): Promise<void> {
  await Promise.all(["jpg", "png", "webp"].map((ext) => unlink(path.join(coversDir, `${id}.${ext}`)).catch(() => {})));
}

/**
 * Periodic temp-file cleanup (Phase 6). Pinned ids (now-playing, queued, staged-unpaid) are
 * never deleted. Returns a stop() to clear the timer.
 */
export function startCleanup(cfg: Config, log: FastifyBaseLogger, pinnedIds: PinnedIdsFn): () => void {
  const tick = async () => {
    try {
      await runCleanupSweep(cfg, log, pinnedIds());
    } catch (err) {
      log.error({ err }, "cleanup: sweep failed");
    }
  };
  const timer = setInterval(() => void tick(), cfg.CLEANUP_INTERVAL_MS);
  void tick(); // run once at boot
  return () => clearInterval(timer);
}
