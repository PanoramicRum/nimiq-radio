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

export const downloadFailures = new client.Counter({
  name: "radio_download_failures_total",
  help: "Download/probe failures by source and failure kind (kind=extractor_stale means yt-dlp needs an update)",
  labelNames: ["source", "kind"] as const,
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

// The canary gauges are NOT registered at module load: prom-client zero-initializes label-less
// gauges, so eager registration would export ok=0 ("failing") from boot until the first probe —
// and forever when the canary is disabled — false-firing any ==0 alert on every (now weekly)
// restart. Instead the canary registers each gauge the first time it has an honest value to
// report, so the series is simply absent until then.
export const youtubeCanaryOk = new client.Gauge({
  name: "radio_youtube_canary_ok",
  help: "1 when the last YouTube canary probe succeeded, 0 when it failed (series absent until the first probe)",
  registers: [],
});

export const youtubeCanaryLastSuccess = new client.Gauge({
  name: "radio_youtube_canary_last_success_seconds",
  help: "Unix time of the last successful YouTube canary probe (series absent until the first success)",
  registers: [],
});

/** Idempotently add a lazily-registered metric to the scrape registry. */
export function registerLazyMetric(metric: client.Metric): void {
  if (!registry.getSingleMetric((metric as unknown as { name: string }).name)) {
    registry.registerMetric(metric);
  }
}
