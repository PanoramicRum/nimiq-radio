import type { AppConfig, RadioState } from "@radio/shared";

/**
 * Read-only HTTP client for the radio backend's public endpoints (the same contract the
 * SPA uses: GET /api/state, GET /api/config). No Telegram knowledge — trivially mockable.
 *
 * We poll over HTTP rather than holding a /ws connection (see apps/web/src/lib/ws.ts for
 * the path not taken): the 1-hour notification debounce makes sub-second latency irrelevant,
 * and stateless polling needs no reconnect/heartbeat/clock-sync machinery and self-heals on
 * a failed request.
 */
export interface RadioClient {
  getState(): Promise<RadioState>;
  getConfig(): Promise<AppConfig>;
}

export interface RadioClientOptions {
  apiUrl: string;
  timeoutMs: number;
}

export function createRadioClient(opts: RadioClientOptions): RadioClient {
  const base = opts.apiUrl.replace(/\/$/, "");

  async function getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // AppConfig rarely changes (paymentsEnabled etc.); cache the first success and reuse it.
  let cachedConfig: AppConfig | null = null;

  return {
    getState: () => getJson<RadioState>("/api/state"),
    async getConfig() {
      if (cachedConfig === null) cachedConfig = await getJson<AppConfig>("/api/config");
      return cachedConfig;
    },
  };
}
