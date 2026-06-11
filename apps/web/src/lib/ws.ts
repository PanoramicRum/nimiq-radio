import type { ClientWsMessage, RadioState, ServerWsMessage } from "@radio/shared";

import { getState } from "../api/client";
import { bestOffset, clockOffsetMs, offsetFromProbe, type OffsetSample } from "./clockSync";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

function wsUrl(): string {
  if (API_BASE) {
    const u = new URL(API_BASE);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws";
    u.search = "";
    return u.toString();
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export interface RadioSnapshot {
  state: RadioState | null;
  offsetMs: number;
  connected: boolean;
}

type Listener = (snap: RadioSnapshot) => void;

const PROBE_INTERVAL_MS = 30_000;
const PROBE_BURST = 5;
const WATCHDOG_MS = 40_000;
const FALLBACK_POLL_MS = 5_000;
const MAX_BACKOFF_MS = 15_000;
const MAX_SAMPLES = 12;
const OFFSET_DEADBAND_MS = 25; // ignore sub-deadband offset jitter so it doesn't churn drift correction

/**
 * Real-time radio connection: WebSocket-first with a polling fallback.
 *  - pushes RadioState (newest seq wins),
 *  - runs NTP-style clock probes to estimate the server-clock offset,
 *  - reconnects with exponential backoff, re-syncs by seq on reconnect,
 *  - a heartbeat watchdog drops a silent socket, and visibility changes re-sync on resume.
 */
export class RadioClient {
  private ws: WebSocket | null = null;
  private state: RadioState | null = null;
  private offsetMs = 0;
  private samples: OffsetSample[] = [];
  private lastSeq = -1;
  private connected = false;
  private stopped = false;
  private backoff = 1000;
  private lastMsgAt = 0;
  private readonly listeners = new Set<Listener>();
  private probeTimer?: number;
  private watchdogTimer?: number;
  private reconnectTimer?: number;
  private fallbackTimer?: number;
  private probeBurstTimers: number[] = [];

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.stopped) return;
    this.connect();
    this.watchdogTimer = window.setInterval(() => {
      if (this.connected && Date.now() - this.lastMsgAt > WATCHDOG_MS) this.ws?.close();
    }, WATCHDOG_MS / 2);
    this.fallbackTimer = window.setInterval(() => {
      if (!this.connected) void this.pollOnce();
    }, FALLBACK_POLL_MS);
    document.addEventListener("visibilitychange", this.onVisibility);
    void this.pollOnce(); // instant first paint before the socket opens
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.clearInterval(this.watchdogTimer);
    window.clearInterval(this.fallbackTimer);
    window.clearInterval(this.probeTimer);
    window.clearTimeout(this.reconnectTimer);
    for (const id of this.probeBurstTimers) window.clearTimeout(id);
    this.probeBurstTimers = [];
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
  }

  requestResync(): void {
    this.send({ type: "resync", seq: this.lastSeq });
  }

  private snapshot(): RadioSnapshot {
    return { state: this.state, offsetMs: this.offsetMs, connected: this.connected };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private onVisibility = (): void => {
    if (document.visibilityState !== "visible") return;
    if (!this.connected) this.connect();
    else {
      this.requestResync();
      this.probeBurst();
    }
  };

  private connect(): void {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.backoff = 1000;
      this.lastMsgAt = Date.now();
      this.requestResync();
      this.probeBurst();
      this.probeTimer = window.setInterval(() => this.probeBurst(), PROBE_INTERVAL_MS);
      this.emit();
    };
    ws.onmessage = (e) => {
      this.lastMsgAt = Date.now();
      this.handle(e.data);
    };
    ws.onclose = () => {
      this.connected = false;
      window.clearInterval(this.probeTimer);
      this.emit();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private send(msg: ClientWsMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private probeBurst(): void {
    // Keep only the most recent in-flight burst ids; old ones have already fired.
    this.probeBurstTimers = [];
    for (let i = 0; i < PROBE_BURST; i++) {
      const id = window.setTimeout(() => this.send({ type: "clockProbe", t0: Date.now() }), i * 120);
      this.probeBurstTimers.push(id);
    }
  }

  private handle(data: unknown): void {
    let msg: ServerWsMessage;
    try {
      msg = JSON.parse(String(data)) as ServerWsMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "state") {
      this.applyState(msg.state);
    } else if (msg.type === "clockProbeReply") {
      const sample = offsetFromProbe(msg.t0, msg.t1, msg.t2, Date.now());
      this.samples.push(sample);
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();
      // Hysteresis: only propagate a meaningfully changed offset, so probe-to-probe jitter doesn't
      // re-trigger the player's drift correction every 30s.
      const next = bestOffset(this.samples);
      if (Math.abs(next - this.offsetMs) > OFFSET_DEADBAND_MS) {
        this.offsetMs = next;
        this.emit();
      }
    }
    // "ping": nothing to do — lastMsgAt was already refreshed.
  }

  private applyState(state: RadioState): void {
    if (state.seq < this.lastSeq) return; // stale
    this.lastSeq = state.seq;
    this.state = state;
    if (this.samples.length === 0) this.offsetMs = clockOffsetMs(state.serverNowMs);
    this.emit();
  }

  private async pollOnce(): Promise<void> {
    try {
      this.applyState(await getState());
    } catch {
      /* transient — try again next tick */
    }
  }
}
