import type { Config } from "../config";
import type { ContentRejectCode, ProbeInfo } from "./Downloader";

export type GateDecision = { ok: true } | { ok: false; reason: string; code: ContentRejectCode };

/**
 * Decide whether probed content is an acceptable song (Phase 7). Pure function.
 *
 * Fail-closed only on STRONG negatives (present-and-contradictory signals); never reject on
 * missing fields — many legitimate songs (esp. music.youtube.com / embeds) omit `categories`,
 * and some omit `duration`. The download's own --match-filter / MAX_DURATION_SEC are the
 * backstop for missing duration.
 */
export function evaluateContent(info: ProbeInfo, cfg: Config): GateDecision {
  if (info.isLive) {
    return { ok: false, code: "live", reason: "Live streams can't be added to the radio." };
  }
  if (typeof info.duration === "number") {
    if (info.duration < cfg.MIN_SONG_SEC) {
      return { ok: false, code: "too_short", reason: `That clip is too short to be a song (under ${cfg.MIN_SONG_SEC}s).` };
    }
    if (info.duration > cfg.MAX_SONG_SEC) {
      const mins = Math.round(cfg.MAX_SONG_SEC / 60);
      return {
        ok: false,
        code: "too_long",
        reason: `That's longer than ${mins} min — podcasts and long videos aren't supported, only songs.`,
      };
    }
  }
  if (cfg.GATE_REQUIRE_MUSIC_CATEGORY && info.categories && info.categories.length > 0) {
    const isMusic = info.categories.some((c) => c.toLowerCase() === "music");
    if (!isMusic) {
      return { ok: false, code: "category", reason: `That doesn't look like a song (category: ${info.categories[0]}).` };
    }
  }
  return { ok: true };
}
