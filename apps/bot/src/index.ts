import { createBot } from "./bot";
import { config } from "./config";
import { logger } from "./logger";
import { startNotifier } from "./notifier";
import { createRadioClient } from "./radioClient";

const COMMANDS = [
  { command: "queue", description: "Now playing + what's coming up" },
  { command: "nowplaying", description: "Just the current track" },
  { command: "stats", description: "Listeners and queue size" },
  { command: "listen", description: "Open the radio" },
  { command: "help", description: "What this bot can do" },
] as const;

async function main(): Promise<void> {
  const radioClient = createRadioClient({ apiUrl: config.RADIO_API_URL, timeoutMs: config.REQUEST_TIMEOUT_MS });
  const bot = createBot({ radioClient, config, log: logger });

  await bot.init();
  logger.info("bot initialized", { username: bot.botInfo.username });
  await bot.api.setMyCommands([...COMMANDS]);

  if (!config.notificationsEnabled) {
    logger.warn("TELEGRAM_CHAT_ID is unset — group notifications are disabled (commands still work)");
  }

  const stopNotifier = startNotifier({ radioClient, bot, config, log: logger });

  // bot.start() resolves only once the bot stops, so don't await it here.
  void bot
    .start({ allowed_updates: ["message"], onStart: (info) => logger.info("long-polling started", { username: info.username }) })
    .catch((err) => logger.error("bot.start failed", { err: String(err) }));

  // Graceful shutdown, mirroring apps/server/src/index.ts — never hang past the stop grace period.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info("shutting down", { signal });
      stopNotifier();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      void Promise.race([bot.stop(), timeout])
        .catch((err) => logger.error("shutdown error", { err: String(err) }))
        .finally(() => process.exit(0));
    });
  }
}

void main().catch((err) => {
  logger.error("fatal: bot failed to start", { err: String(err) });
  process.exit(1);
});
