import { z } from "zod";

/**
 * Environment configuration for the Telegram bot, parsed and validated once at boot.
 * Mirrors the pattern in apps/server/src/config.ts (zod schema + readable aggregated
 * errors + empty-string-as-undefined for docker env).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // ── Telegram ──
  // From @BotFather. Required — the bot cannot run without it.
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required (get one from @BotFather)"),
  // Community group/channel for "music started" notifications. Numeric id (e.g. -1001234567890)
  // or @username. Unset -> notifications disabled, commands still work.
  TELEGRAM_CHAT_ID: z.string().optional(),

  // ── Radio endpoints ──
  // Public site URL used in /listen and the notification button.
  RADIO_PUBLIC_URL: z.string().url().default("https://radio.nimiqapps.com"),
  // Internal API the bot polls. The SERVER never calls Telegram; only the bot does.
  RADIO_API_URL: z.string().url().default("http://server:3000"),

  // ── Notification tuning ──
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  // Minutes the user-queue must be empty (filler/idle only) before a new song notifies.
  EMPTY_THRESHOLD_MIN: z.coerce.number().int().positive().default(60),
  // Persisted notification state (single tiny JSON file on a docker volume).
  STATE_FILE_PATH: z.string().default("/data/bot-state.json"),

  // ── Display ──
  QUEUE_DISPLAY_LIMIT: z.coerce.number().int().positive().default(10),
  // Timeout for each radio API request.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export type Config = z.infer<typeof EnvSchema> & {
  /** Quiet window before a quiet->active transition notifies, in ms. */
  quietThresholdMs: number;
  /** Resolved chat id, or undefined when notifications are disabled. */
  chatId: string | undefined;
  /** True when a notification chat is configured. */
  notificationsEnabled: boolean;
};

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // Treat empty-string optionals (common in docker env) as undefined.
  const emptyToUndef = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
  const chatId = emptyToUndef(env.TELEGRAM_CHAT_ID);

  return {
    ...env,
    quietThresholdMs: env.EMPTY_THRESHOLD_MIN * 60_000,
    chatId,
    notificationsEnabled: chatId !== undefined,
  };
}

export const config = loadConfig();
