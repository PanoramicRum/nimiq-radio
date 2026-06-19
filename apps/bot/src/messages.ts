import type { AppConfig, QueueItem, RadioState } from "@radio/shared";

import { elapsedSeconds, escapeHtml, formatDuration, formatPaid, shortAddress } from "./format";

// Pure message builders (Telegram HTML parse mode). Kept free of grammY so they unit-test
// without a live bot. Every dynamic string is escaped — titles/authors are arbitrary.

/** "<b>Title</b> — Author", both escaped. Author omitted when absent. */
function formatTrack(item: QueueItem): string {
  const title = `<b>${escapeHtml(item.title)}</b>`;
  return item.author ? `${title} — ${escapeHtml(item.author)}` : title;
}

/** "(1:23 / 3:45)" when both known, "(1:23)" with only elapsed, or "" when neither. */
function formatProgress(state: RadioState): string {
  if (state.current === null) return "";
  const elapsed = formatDuration(elapsedSeconds(state));
  const total = state.current.duration ? ` / ${formatDuration(state.current.duration)}` : "";
  return ` (${elapsed}${total})`;
}

/** The user song that leads the session — the playing one, else the first queued. */
function leadUserSong(state: RadioState): QueueItem | null {
  if (state.current !== null && state.current.isRadio !== true) return state.current;
  return state.queue[0] ?? null;
}

/** One line describing what is on air right now. */
export function nowPlayingLine(state: RadioState): string {
  if (state.current === null) return "🔇 Nothing playing right now (idle).";
  if (state.current.isRadio === true) return `📻 Filler (CC0): ${formatTrack(state.current)}${formatProgress(state)}`;
  return `▶️ ${formatTrack(state.current)}${formatProgress(state)}`;
}

function listenersLine(state: RadioState): string {
  return state.listeners === 1 ? "👥 1 listener" : `👥 ${state.listeners} listeners`;
}

/** /queue — now playing plus the upcoming user queue, truncated to `limit`. */
export function buildQueueMessage(state: RadioState, appConfig: AppConfig, limit: number): string {
  const lines = ["🎶 <b>Nimiq Radio</b>", "", nowPlayingLine(state)];

  if (state.queue.length === 0) {
    lines.push("", "No songs queued — add one to take over the airwaves.");
  } else {
    lines.push("", "<b>Up next:</b>");
    state.queue.slice(0, limit).forEach((item, i) => {
      const paid = appConfig.paymentsEnabled ? ` · ${formatPaid(item.amountPaid)}` : "";
      lines.push(`${i + 1}. ${formatTrack(item)}${paid}`);
    });
    const remaining = state.queue.length - limit;
    if (remaining > 0) lines.push(`…and ${remaining} more`);
  }

  lines.push("", listenersLine(state));
  return lines.join("\n");
}

/** /nowplaying — just the current track. */
export function buildNowPlayingMessage(state: RadioState): string {
  const lines = [nowPlayingLine(state)];
  if (state.current !== null && state.current.isRadio !== true && state.current.submittedBy) {
    lines.push(`🙋 Added by ${escapeHtml(shortAddress(state.current.submittedBy))}`);
  }
  lines.push("", listenersLine(state));
  return lines.join("\n");
}

/** /stats — a quick "how busy is the radio" snapshot. */
export function buildStatsMessage(state: RadioState): string {
  const onAir = state.current === null ? "idle" : state.current.isRadio === true ? "filler (CC0)" : "a listener's song";
  const paid = state.queue.filter((i) => i.amountPaid > 0).length;
  const free = state.queue.length - paid;
  return [
    "📊 <b>Radio stats</b>",
    `On air: ${onAir}`,
    `In queue: ${state.queue.length} song${state.queue.length === 1 ? "" : "s"} (${paid} paid · ${free} free)`,
    listenersLine(state),
  ].join("\n");
}

/** /start and /help — intro + command list. */
export function buildHelpMessage(): string {
  return [
    "🎵 <b>Nimiq Radio bot</b>",
    "I keep the community posted on what's playing.",
    "",
    "/queue — now playing + what's coming up",
    "/nowplaying — just the current track",
    "/stats — listeners and queue size",
    "/listen — open the radio",
    "/help — this message",
  ].join("\n");
}

/** /listen — text shown alongside the inline Listen button. */
export function buildListenMessage(publicUrl: string): string {
  return `🎧 Tune in to Nimiq Radio:\n${escapeHtml(publicUrl)}`;
}

/** The "music is back on" group notification (fired after a long quiet stretch). */
export function buildNotificationMessage(state: RadioState): string {
  const lead = leadUserSong(state);
  const what = lead ? `\n${formatTrack(lead)} is up.` : "";
  return `🎶 The music is back on! Someone just queued a song on Nimiq Radio — come listen.${what}`;
}
