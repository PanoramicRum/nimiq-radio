import { LUNA_PER_NIM } from "@radio/shared";
import { z } from "zod";

/**
 * Environment configuration, parsed and validated once at boot.
 * Defaults mirror packages/shared DEFAULT_CAPS so local dev works with no .env.
 */
/** Parse a boolean env var safely. z.coerce.boolean() turns "false" into true — don't use it. */
const boolFromEnv = (def: boolean) =>
  z.preprocess((v) => (v === undefined || v === "" ? def : String(v).trim().toLowerCase() === "true"), z.boolean());

const EnvSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  TRACKS_DIR: z.string().default("/tmp/radio-tracks"),
  CORS_ORIGIN: z.string().default("*"),

  // Media pipeline
  YTDLP_BIN: z.string().default("yt-dlp"),
  MAX_DURATION_SEC: z.coerce.number().int().positive().default(1500), // download cap (25 min); must be >= MAX_SONG_SEC
  MAX_FILESIZE: z.string().default("100M"),
  // Native container to keep — "m4a" downloads YouTube's audio-only AAC stream and copies it
  // (no costly re-encode). yt-dlp only re-encodes if no audio-only source exists for the video.
  AUDIO_FORMAT: z.string().default("m4a"),
  AUDIO_BITRATE: z.string().default("192K"), // only used on the rare re-encode fallback
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().default(2),
  DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // Datacenter-IP hardening (optional)
  PO_TOKEN_BASE_URL: z.string().optional(),
  // "default" exposes audio-only m4a (itag 140) so we download ~4 MB instead of a full video
  // stream; web_safari,tv kept as a fallback chain for robustness. yt-dlp merges formats across
  // the listed clients, so it stays resilient if the first client is blocked.
  PLAYER_CLIENT: z.string().default("default,web_safari,tv"),
  COOKIES_FILE: z.string().optional(),

  // ── YouTube canary ──
  // Periodic metadata-only probe of a known-stable public video through the real pipeline
  // (player_client, PO-token sidecar, cookies), so extractor breakage — stale yt-dlp after a
  // YouTube-side change — is detected before users report it. 0 disables; empty string means
  // "use the default" (the .env idiom for other optionals), NOT "disable". Capped at 2^31-1:
  // Node clamps larger setInterval delays to 1 ms, which would probe continuously.
  YT_CANARY_INTERVAL_MS: z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    z.coerce.number().int().nonnegative().max(2_147_483_647).default(21_600_000), // 6 h
  ),
  YT_CANARY_URL: z.string().default("https://www.youtube.com/watch?v=jNQXAC9IVRw"),

  // Rate limiting (basic, even in Phase 1)
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),

  // ── Nimiq payments (Phase 3) ──
  // Payments are ENABLED only when RECIPIENT_ADDRESS is set; otherwise songs are free.
  NIMIQ_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  RPC_URL: z.string().optional(),
  RECIPIENT_ADDRESS: z.string().optional(),
  MIN_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(10),
  PRICE_NIM: z.coerce.number().nonnegative().default(1),

  // ── Persistence + hardening (Phase 6) ──
  // SQLite file for restart survival + durable replay guard. Defaults to a file in
  // TRACKS_DIR (the docker volume). Set DB_PATH="" to disable (in-memory only).
  DB_PATH: z.string().optional(),
  FILE_TTL_MIN: z.coerce.number().int().positive().default(180), // delete temp MP3s older than this
  CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  DISK_CAP_MB: z.coerce.number().int().positive().default(4096), // LRU-evict MP3s above this
  // Nimiq Pay origin to allow embedding the mini app (CSP frame-ancestors hint, docs only).
  NIMIQ_PAY_ORIGIN: z.string().optional(),

  // ── Song metadata + content gate (Phase 7) ──
  // AcoustID fingerprint lookup for real artist/title/album. Unset -> tagger disabled (keeps yt-dlp metadata).
  ACOUSTID_API_KEY: z.string().optional(),
  FPCALC_BIN: z.string().default("fpcalc"),
  ACOUSTID_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),
  ACOUSTID_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  FPCALC_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // ── Album cover art ──
  // Best-effort: Cover Art Archive (via the AcoustID release-group MBID) -> yt-dlp thumbnail fallback.
  COVER_ENABLED: boolFromEnv(true),
  COVER_SIZE: z.enum(["250", "500", "1200"]).default("500"), // Cover Art Archive front-<N>
  COVER_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  COVER_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  // Content gate: reject non-songs before downloading.
  CONTENT_GATE_ENABLED: boolFromEnv(true),
  // Off by default: YouTube miscategorizes many legit songs (e.g. "People & Blogs"), so the
  // category is too blunt a filter. Length + not-live still gate; AcoustID identifies the song.
  GATE_REQUIRE_MUSIC_CATEGORY: boolFromEnv(false),
  MIN_SONG_SEC: z.coerce.number().int().positive().default(45),
  MAX_SONG_SEC: z.coerce.number().int().positive().default(1500), // 25 min

  // ── Always-on Creative-Commons filler (Phase 8) ──
  // The radio plays public-domain (CC0) filler whenever no user song is queued, so it is
  // never silent. Audio is fetched into FILLER_DIR by deploy/fetch-filler.sh (not committed).
  FILLER_ENABLED: boolFromEnv(true),
  FILLER_DIR: z.string().optional(), // audio dir; default <TRACKS_DIR>/library
  FILLER_MANIFEST: z.string().optional(), // manifest path; default apps/server/filler/manifest.json
});

const DEFAULT_RPC: Record<"mainnet" | "testnet", string> = {
  mainnet: "https://rpc.nimiqwatch.com",
  testnet: "https://rpc.nimiq-testnet.com",
};

export type Config = z.infer<typeof EnvSchema> & {
  /** Resolved JSON-RPC endpoint. */
  rpcUrl: string;
  /** Trimmed recipient address, or undefined when payments are disabled. */
  recipientAddress: string | undefined;
  /** True when a recipient address is configured. */
  paymentsEnabled: boolean;
  /** Minimum price per song, in Luna. */
  priceLuna: number;
  /** Resolved SQLite path, or null when persistence is disabled. */
  dbPath: string | null;
  /** True when an AcoustID key is configured (fingerprint metadata enabled). */
  taggerEnabled: boolean;
  /** Directory holding downloaded CC0 filler audio (default <TRACKS_DIR>/library). */
  fillerDir: string;
  /** Override path to the filler manifest JSON, or null to use the built-in default. */
  fillerManifestPath: string | null;
};

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // Treat empty-string optionals (common in docker env) as undefined.
  const emptyToUndef = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
  env.PO_TOKEN_BASE_URL = emptyToUndef(env.PO_TOKEN_BASE_URL);
  env.COOKIES_FILE = emptyToUndef(env.COOKIES_FILE);
  env.ACOUSTID_API_KEY = emptyToUndef(env.ACOUSTID_API_KEY);

  if (env.MIN_SONG_SEC >= env.MAX_SONG_SEC) {
    throw new Error(`MIN_SONG_SEC (${env.MIN_SONG_SEC}) must be < MAX_SONG_SEC (${env.MAX_SONG_SEC}).`);
  }
  if (env.MAX_SONG_SEC > env.MAX_DURATION_SEC) {
    throw new Error(`MAX_SONG_SEC (${env.MAX_SONG_SEC}) must be <= MAX_DURATION_SEC (${env.MAX_DURATION_SEC}); otherwise the gate accepts songs the downloader then rejects.`);
  }

  const recipientAddress = emptyToUndef(env.RECIPIENT_ADDRESS);
  const rpcUrl = emptyToUndef(env.RPC_URL) ?? DEFAULT_RPC[env.NIMIQ_NETWORK];
  env.NIMIQ_PAY_ORIGIN = emptyToUndef(env.NIMIQ_PAY_ORIGIN);

  // DB_PATH: undefined -> default in TRACKS_DIR; "" -> disabled (null); else as given.
  const dbPath = env.DB_PATH === undefined ? `${env.TRACKS_DIR}/radio.db` : env.DB_PATH.trim() === "" ? null : env.DB_PATH.trim();

  return {
    ...env,
    rpcUrl,
    recipientAddress,
    paymentsEnabled: recipientAddress !== undefined,
    priceLuna: Math.round(env.PRICE_NIM * LUNA_PER_NIM),
    dbPath,
    taggerEnabled: env.ACOUSTID_API_KEY !== undefined,
    fillerDir: emptyToUndef(env.FILLER_DIR) ?? `${env.TRACKS_DIR}/library`,
    fillerManifestPath: emptyToUndef(env.FILLER_MANIFEST) ?? null,
  };
}

export const config = loadConfig();
