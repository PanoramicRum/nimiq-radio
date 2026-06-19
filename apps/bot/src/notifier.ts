import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";

import type { Config } from "./config";
import type { Logger } from "./logger";
import { buildNotificationMessage } from "./messages";
import type { RadioClient } from "./radioClient";
import { evaluate, initState, loadState, type NotifState, saveState } from "./state";

export interface NotifierDeps {
  radioClient: RadioClient;
  bot: Bot;
  config: Config;
  log: Logger;
}

/**
 * Background poller that drives the notification state machine. Modeled on
 * apps/server/src/fs/cleanup.ts (setInterval + a returned stop()).
 *
 * Each tick polls GET /api/state and runs the pure `evaluate`. A FAILED poll skips the tick
 * entirely (no evaluate, no state mutation) so a server outage is never misread as "quiet".
 * State is persisted after every successful evaluation; the notification is best-effort
 * (a Telegram failure is logged but never re-spammed — state is already advanced).
 */
export function startNotifier(deps: NotifierDeps): () => void {
  const { radioClient, bot, config, log } = deps;
  let prev: NotifState | null = null;

  async function tick(): Promise<void> {
    let state;
    try {
      state = await radioClient.getState();
    } catch (err) {
      log.warn("notifier: poll failed, skipping tick", { err: String(err) });
      return;
    }

    const now = Date.now();

    // Cold start: baseline from the first observed poll; never notifies.
    if (prev === null) {
      prev = (await loadState(config.STATE_FILE_PATH)) ?? initState(state, now);
      await saveState(config.STATE_FILE_PATH, prev);
      return;
    }

    const { next, notify } = evaluate(prev, state, now, config.quietThresholdMs);
    prev = next;
    await saveState(config.STATE_FILE_PATH, next);

    if (!notify) return;
    if (!config.notificationsEnabled || config.chatId === undefined) {
      log.info("notifier: would notify (TELEGRAM_CHAT_ID unset)");
      return;
    }

    try {
      await bot.api.sendMessage(config.chatId, buildNotificationMessage(state), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url("🎧 Open Nimiq Radio", config.RADIO_PUBLIC_URL),
      });
      log.info("notifier: sent 'music is back' notification", { chatId: config.chatId });
    } catch (err) {
      // State already advanced to "active" — do NOT retry (avoids spam). Just log.
      log.error("notifier: failed to send notification", { err: String(err) });
    }
  }

  const timer = setInterval(() => void tick(), config.POLL_INTERVAL_MS);
  void tick(); // run once at boot to establish the baseline immediately
  return () => clearInterval(timer);
}
