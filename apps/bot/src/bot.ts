import type { AppConfig, RadioState } from "@radio/shared";
import { Bot, type Context, InlineKeyboard } from "grammy";

import type { Config } from "./config";
import type { Logger } from "./logger";
import {
  buildHelpMessage,
  buildListenMessage,
  buildNowPlayingMessage,
  buildQueueMessage,
  buildStatsMessage,
} from "./messages";
import type { RadioClient } from "./radioClient";

export interface BotDeps {
  radioClient: RadioClient;
  config: Config;
  log: Logger;
}

const REPLY_HTML = { parse_mode: "HTML" } as const;

/**
 * Build the grammY bot with its command handlers. Lifecycle (init/start/stop) is owned by
 * index.ts. Handlers fetch fresh radio state on demand so replies are always current,
 * independent of the notifier's poll cadence.
 */
export function createBot(deps: BotDeps): Bot {
  const { radioClient, config, log } = deps;
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  const listenButton = () => new InlineKeyboard().url("🎧 Open Nimiq Radio", config.RADIO_PUBLIC_URL);

  // Shared helper: fetch state+config, build a reply, fail gracefully if the radio is unreachable.
  async function replyWithState(ctx: Context, build: (state: RadioState, appConfig: AppConfig) => string, withButton: boolean): Promise<void> {
    try {
      const [state, appConfig] = await Promise.all([radioClient.getState(), radioClient.getConfig()]);
      await ctx.reply(build(state, appConfig), { ...REPLY_HTML, reply_markup: withButton ? listenButton() : undefined });
    } catch (err) {
      log.warn("radio status unavailable", { err: String(err) });
      await ctx.reply("⚠️ Radio status is unavailable right now — please try again in a moment.");
    }
  }

  bot.command(["start", "help"], (ctx) => ctx.reply(buildHelpMessage(), { ...REPLY_HTML, reply_markup: listenButton() }));

  bot.command("queue", (ctx) => replyWithState(ctx, (state, appConfig) => buildQueueMessage(state, appConfig, config.QUEUE_DISPLAY_LIMIT), true));

  bot.command("nowplaying", (ctx) => replyWithState(ctx, (state) => buildNowPlayingMessage(state), true));

  bot.command("stats", (ctx) => replyWithState(ctx, (state) => buildStatsMessage(state), false));

  bot.command("listen", (ctx) => ctx.reply(buildListenMessage(config.RADIO_PUBLIC_URL), { ...REPLY_HTML, reply_markup: listenButton() }));

  // A thrown handler must never kill long-polling.
  bot.catch((err) => log.error("bot handler error", { err: String(err.error), update: err.ctx.update.update_id }));

  return bot;
}
