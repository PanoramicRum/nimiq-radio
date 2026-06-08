/** 1 NIM = 100,000 Luna (the smallest NIM unit). */
export const LUNA_PER_NIM = 100_000;

/** Nimiq Albatross network ids used to pin payment verification to an environment. */
export const NETWORK_ID = {
  mainnet: 24,
  testnet: 5,
} as const;
export type NimiqNetwork = keyof typeof NETWORK_ID;

/** Lifecycle of a prepared/queued track. Phase 1 only uses "ready" | "failed". */
export const TRACK_STATUSES = [
  "pending",
  "ready",
  "playing",
  "played",
  "failed",
] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

/**
 * Default resource caps. The server reads its live values from env (see config),
 * these are the shared defaults and the values the UI can reference.
 */
export const DEFAULT_CAPS = {
  maxDurationSec: 900, // 15 min
  maxFilesize: "100M",
  audioBitrate: "192K",
  downloadConcurrency: 2,
  downloadTimeoutMs: 120_000,
} as const;
