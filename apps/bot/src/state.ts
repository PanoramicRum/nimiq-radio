import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import type { RadioState } from "@radio/shared";

const STATE_VERSION = 1;

/**
 * Persisted notification state. Tiny — a phase flag plus two timestamps — so it lives in a
 * single JSON file (atomic write) rather than SQLite: there are no queries, no relations, and
 * a single writer.
 */
export interface NotifState {
  version: number;
  phase: "quiet" | "active";
  /** Epoch ms the CURRENT quiet stretch began; null while active. */
  quietSinceMs: number | null;
  /** Epoch ms of the last notification sent (diagnostics). */
  lastNotifiedAtMs: number | null;
}

/**
 * A user song is "active" when a non-filler track plays or any user song is queued. Phase 8
 * CC0 filler (isRadio:true) lives in `current`, never in `queue[]`, and does NOT count — the
 * radio is never silent, so "quiet" means only-filler-or-idle.
 */
export function hasUserSong(state: RadioState): boolean {
  return state.queue.length > 0 || (state.current !== null && state.current.isRadio !== true);
}

export function isQuiet(state: RadioState): boolean {
  return !hasUserSong(state);
}

/**
 * Cold-start baseline from the first observed poll. Never notifies on first observation — the
 * bot must not blast the group the instant it boots.
 */
export function initState(state: RadioState, nowMs: number): NotifState {
  return isQuiet(state)
    ? { version: STATE_VERSION, phase: "quiet", quietSinceMs: nowMs, lastNotifiedAtMs: null }
    : { version: STATE_VERSION, phase: "active", quietSinceMs: null, lastNotifiedAtMs: null };
}

/**
 * The notification state machine. Pure: same (prev, state, nowMs, thresholdMs) → same result.
 * Run on every SUCCESSFUL poll (a failed poll must not call this — a server outage is not "quiet").
 *
 *  - quiet  → keep/accumulate quietSinceMs; on active→quiet edge, stamp quietSinceMs = now.
 *  - active → on quiet→active edge, notify iff the quiet stretch was >= threshold; otherwise
 *             stay active and never notify again until we return to quiet and re-accumulate.
 *
 * Guarantees: exactly one notification per quiet→active session, immune to oscillation
 * (the first active edge consumes + resets the accumulated quiet window), and restart-safe
 * (quietSinceMs / phase are persisted and reloaded).
 */
export function evaluate(prev: NotifState, state: RadioState, nowMs: number, thresholdMs: number): { next: NotifState; notify: boolean } {
  if (isQuiet(state)) {
    if (prev.phase === "active") {
      // active → quiet: start a fresh quiet stretch.
      return { next: { ...prev, phase: "quiet", quietSinceMs: nowMs }, notify: false };
    }
    // still quiet: keep accumulating (defensively stamp if somehow null).
    const quietSinceMs = prev.quietSinceMs ?? nowMs;
    return { next: { ...prev, quietSinceMs }, notify: false };
  }

  // state has a user song.
  if (prev.phase === "quiet") {
    // quiet → active edge: the moment a song is added. Notify iff it was quiet long enough.
    const quietForMs = prev.quietSinceMs === null ? Number.POSITIVE_INFINITY : nowMs - prev.quietSinceMs;
    const notify = quietForMs >= thresholdMs;
    return {
      next: { ...prev, phase: "active", quietSinceMs: null, lastNotifiedAtMs: notify ? nowMs : prev.lastNotifiedAtMs },
      notify,
    };
  }
  // already active: a further song in the same session — never re-notify.
  return { next: prev, notify: false };
}

/**
 * Load persisted state. Returns null (caller cold-starts) on a missing file, a parse error,
 * or a version mismatch — corruption is logged by the caller, never fatal.
 */
export async function loadState(filePath: string): Promise<NotifState | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null; // ENOENT on first boot, etc.
  }
  try {
    const parsed = JSON.parse(raw) as NotifState;
    if (parsed.version !== STATE_VERSION || (parsed.phase !== "quiet" && parsed.phase !== "active")) {
      return null;
    }
    return parsed;
  } catch {
    return null; // corrupt JSON
  }
}

/** Atomic write: tmp file + rename (same dir) so a crash mid-write never corrupts state. */
export async function saveState(filePath: string, s: NotifState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(s), "utf8");
  await rename(tmp, filePath);
}
