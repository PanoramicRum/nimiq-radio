import type { AppConfig, BoostIntentResponse, BoostResponse, PrepareSongResponse, RadioState, SubmitResponse } from "@radio/shared";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch(`${API_BASE}/api/config`);
  if (!res.ok) throw new Error(`GET /api/config failed: ${res.status}`);
  return (await res.json()) as AppConfig;
}

export async function prepareSong(url: string): Promise<PrepareSongResponse> {
  const res = await fetch(`${API_BASE}/api/prepare-song`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return (await res.json()) as PrepareSongResponse;
}

export async function submitSong(prepareId: string, sdkResult: string): Promise<SubmitResponse> {
  // Note: a 202 (pending) still carries a JSON body — don't gate on res.ok.
  const res = await fetch(`${API_BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prepareId, sdkResult }),
  });
  return (await res.json()) as SubmitResponse;
}

export async function getBoostIntent(queueItemId: string): Promise<BoostIntentResponse> {
  const res = await fetch(`${API_BASE}/api/boost-intent?queueItemId=${encodeURIComponent(queueItemId)}`);
  return (await res.json()) as BoostIntentResponse;
}

export async function boostSong(boostId: string, sdkResult: string): Promise<BoostResponse> {
  const res = await fetch(`${API_BASE}/api/boost`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ boostId, sdkResult }),
  });
  return (await res.json()) as BoostResponse;
}

export async function getState(): Promise<RadioState> {
  const res = await fetch(`${API_BASE}/api/state`);
  if (!res.ok) throw new Error(`GET /api/state failed: ${res.status}`);
  return (await res.json()) as RadioState;
}
