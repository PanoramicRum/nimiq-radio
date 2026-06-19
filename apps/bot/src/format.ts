import { LUNA_PER_NIM, type RadioState } from "@radio/shared";

// Formatters ported from apps/web/src/lib/format.ts — @radio/shared exports types/constants
// only, not these helpers, so the bot keeps its own copy (no cross-app UI dependency).

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function lunaToNim(luna: number): string {
  return (luna / LUNA_PER_NIM).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** "NQ12 ABCD … WXYZ" — compact a Nimiq address for display. */
export function shortAddress(addr: string): string {
  const compact = addr.replace(/\s+/g, "");
  if (compact.length <= 12) return addr;
  return `${compact.slice(0, 8)}…${compact.slice(-4)}`;
}

/** "free" while unpaid (Phase 2); "<n> NIM" once payments land (Phase 3+). */
export function formatPaid(amountLuna: number): string {
  return amountLuna > 0 ? `${lunaToNim(amountLuna)} NIM` : "free";
}

/**
 * Seconds elapsed in the current track, clamped to [0, duration]. Uses the server's
 * own clock at snapshot time (serverNowMs - startedAtServerMs) so it is immune to the
 * bot host's clock skew — we never run the WS clock-sync probe.
 */
export function elapsedSeconds(state: RadioState): number {
  if (state.current === null || state.startedAtServerMs === null) return 0;
  const raw = (state.serverNowMs - state.startedAtServerMs) / 1000;
  const max = state.current.duration ?? Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(raw, max));
}

/**
 * Escape text for Telegram HTML parse mode. Song titles/authors come from yt-dlp/AcoustID
 * and contain arbitrary characters, so every dynamic string MUST pass through this.
 * https://core.telegram.org/bots/api#html-style
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
