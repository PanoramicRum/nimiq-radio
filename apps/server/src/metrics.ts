import client from "prom-client";

/** Prometheus registry with default process metrics + a few app counters (Phase 6). */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const songsPrepared = new client.Counter({
  name: "radio_songs_prepared_total",
  help: "Songs successfully downloaded + transcoded",
  registers: [registry],
});

export const paymentsVerified = new client.Counter({
  name: "radio_payments_verified_total",
  help: "On-chain payments verified and applied",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const songsRejected = new client.Counter({
  name: "radio_songs_rejected_total",
  help: "Submissions rejected by the content gate",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const songsTagged = new client.Counter({
  name: "radio_songs_tagged_total",
  help: "Songs whose metadata was corrected via AcoustID fingerprint",
  registers: [registry],
});

export const taggerErrors = new client.Counter({
  name: "radio_tagger_errors_total",
  help: "Fingerprint/AcoustID failures (degraded to yt-dlp metadata)",
  registers: [registry],
});

export const coversResolved = new client.Counter({
  name: "radio_covers_resolved_total",
  help: "Songs for which cover art was fetched + stored",
  labelNames: ["source"] as const,
  registers: [registry],
});

export const coverErrors = new client.Counter({
  name: "radio_cover_errors_total",
  help: "Cover-art fetch failures (degraded to no cover)",
  registers: [registry],
});
