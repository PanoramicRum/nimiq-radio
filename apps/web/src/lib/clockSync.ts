/**
 * Server-clock alignment for the shared radio.
 *
 * Phase 5 uses an NTP-style probe over the WebSocket: the client stamps t0 (send), the
 * server stamps t1 (receive) and t2 (send), and the client stamps t3 (receive). From a
 * round of probes we keep the lowest-RTT half and take the median offset, which is robust
 * to jittery mobile networks. `clockOffsetMs` (single-sample) seeds the estimate from the
 * first /api/state snapshot before any probe completes.
 */

export interface OffsetSample {
  offset: number;
  rtt: number;
}

/** One NTP sample from a completed probe round-trip. */
export function offsetFromProbe(t0: number, t1: number, t2: number, t3: number): OffsetSample {
  return {
    offset: (t1 - t0 + (t2 - t3)) / 2,
    rtt: t3 - t0 - (t2 - t1),
  };
}

/** Median offset of the lowest-RTT half of the samples (0 when there are none). */
export function bestOffset(samples: OffsetSample[]): number {
  if (samples.length === 0) return 0;
  const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
  const half = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 2)));
  const offsets = half.map((s) => s.offset).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  return offsets.length % 2 === 1 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2;
}

/** Coarse single-sample offset from a snapshot's serverNowMs (used before WS probes land). */
export function clockOffsetMs(serverNowMs: number): number {
  return serverNowMs - Date.now();
}

/** Live position (seconds) into the current track, given when the server started it. */
export function livePositionSec(startedAtServerMs: number, offsetMs: number): number {
  return Math.max(0, (Date.now() + offsetMs - startedAtServerMs) / 1000);
}
