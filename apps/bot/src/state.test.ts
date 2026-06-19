import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { QueueItem, RadioState } from "@radio/shared";
import { describe, expect, it } from "vitest";

import { evaluate, hasUserSong, initState, isQuiet, loadState, type NotifState, saveState } from "./state";

const THRESHOLD = 60 * 60 * 1000; // 1 hour

function userSong(over: Partial<QueueItem> = {}): QueueItem {
  return { id: "u1", sourceUrl: "https://x", trackUrl: "/static/tracks/u1.m4a", title: "Song", amountPaid: 0, createdAt: "2026-01-01T00:00:00Z", status: "ready", ...over };
}
function fillerSong(over: Partial<QueueItem> = {}): QueueItem {
  return userSong({ id: "f1", title: "Filler", isRadio: true, ...over });
}
function makeState(over: Partial<RadioState> = {}): RadioState {
  return { current: null, startedAtServerMs: null, queue: [], paused: false, seq: 1, listeners: 0, serverNowMs: 0, ...over };
}
const quiet = (): RadioState => makeState({ current: fillerSong(), startedAtServerMs: 1000, serverNowMs: 2000 });
const active = (): RadioState => makeState({ current: userSong(), startedAtServerMs: 1000, serverNowMs: 2000 });

/** Feed a sequence of [state, nowMs] through evaluate, threading prev. Returns the notify count. */
function run(start: NotifState, steps: Array<[RadioState, number]>): { final: NotifState; notifyCount: number } {
  let prev = start;
  let notifyCount = 0;
  for (const [state, now] of steps) {
    const { next, notify } = evaluate(prev, state, now, THRESHOLD);
    prev = next;
    if (notify) notifyCount += 1;
  }
  return { final: prev, notifyCount };
}

describe("isQuiet / hasUserSong", () => {
  it("treats idle and filler-only as quiet", () => {
    expect(isQuiet(makeState())).toBe(true); // idle
    expect(isQuiet(makeState({ current: fillerSong() }))).toBe(true); // only filler
  });
  it("treats a playing user song or any queued song as active", () => {
    expect(hasUserSong(makeState({ current: userSong() }))).toBe(true);
    expect(hasUserSong(makeState({ current: fillerSong(), queue: [userSong()] }))).toBe(true); // filler + queued
    expect(hasUserSong(makeState({ current: null, queue: [userSong()] }))).toBe(true);
  });
});

describe("initState (cold-start baseline)", () => {
  it("never carries a notify and reflects the observed phase", () => {
    expect(initState(quiet(), 50)).toEqual({ version: 1, phase: "quiet", quietSinceMs: 50, lastNotifiedAtMs: null });
    expect(initState(active(), 50)).toEqual({ version: 1, phase: "active", quietSinceMs: null, lastNotifiedAtMs: null });
  });
});

describe("evaluate", () => {
  const quietPrev = (quietSinceMs: number | null): NotifState => ({ version: 1, phase: "quiet", quietSinceMs, lastNotifiedAtMs: null });
  const activePrev = (): NotifState => ({ version: 1, phase: "active", quietSinceMs: null, lastNotifiedAtMs: null });

  it("notifies on quiet→active after >= threshold (once), clearing quietSinceMs", () => {
    const { next, notify } = evaluate(quietPrev(0), active(), THRESHOLD, THRESHOLD);
    expect(notify).toBe(true);
    expect(next.phase).toBe("active");
    expect(next.quietSinceMs).toBeNull();
    expect(next.lastNotifiedAtMs).toBe(THRESHOLD);
  });

  it("does NOT notify on quiet→active under the threshold", () => {
    const { next, notify } = evaluate(quietPrev(0), active(), THRESHOLD - 1, THRESHOLD);
    expect(notify).toBe(false);
    expect(next.phase).toBe("active");
  });

  it("does NOT notify active→active (a second song in the same session)", () => {
    const prev = activePrev();
    const { next, notify } = evaluate(prev, active(), 9_999_999, THRESHOLD);
    expect(notify).toBe(false);
    expect(next).toEqual(prev);
  });

  it("stamps quietSinceMs on active→quiet", () => {
    const { next, notify } = evaluate(activePrev(), quiet(), 1234, THRESHOLD);
    expect(notify).toBe(false);
    expect(next.phase).toBe("quiet");
    expect(next.quietSinceMs).toBe(1234);
  });

  it("keeps accumulating quietSinceMs while staying quiet (restart-safe clock)", () => {
    const { next } = evaluate(quietPrev(100), quiet(), 5000, THRESHOLD);
    expect(next.quietSinceMs).toBe(100); // unchanged — a reloaded clock is not reset
  });

  it("notifies again only after another full quiet window, not on a quick re-activation", () => {
    const { notifyCount, final } = run(quietPrev(0), [
      [active(), THRESHOLD], // notify #1
      [quiet(), THRESHOLD + 10], // session ends
      [active(), THRESHOLD + 20], // 10ms quiet → no notify
      [quiet(), THRESHOLD + 30], // ends again
      [active(), THRESHOLD + 30 + THRESHOLD], // full hour quiet → notify #2
    ]);
    expect(notifyCount).toBe(2);
    expect(final.phase).toBe("active");
  });

  it("never double-fires under rapid oscillation within the window", () => {
    const steps: Array<[RadioState, number]> = [[active(), THRESHOLD]]; // notify #1
    // Flap quiet/active every minute for ~30 min — all quiet stretches are tiny.
    for (let i = 1; i <= 30; i++) steps.push([i % 2 === 0 ? active() : quiet(), THRESHOLD + i * 60_000]);
    const { notifyCount } = run({ version: 1, phase: "quiet", quietSinceMs: 0, lastNotifiedAtMs: null }, steps);
    expect(notifyCount).toBe(1);
  });
});

describe("loadState / saveState", () => {
  it("round-trips and rejects missing / corrupt / version-mismatched files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bot-state-"));
    try {
      const file = path.join(dir, "state.json");
      const s: NotifState = { version: 1, phase: "quiet", quietSinceMs: 123, lastNotifiedAtMs: null };

      await saveState(file, s);
      expect(await loadState(file)).toEqual(s); // round-trip → restart-safe

      expect(await loadState(path.join(dir, "missing.json"))).toBeNull();

      await writeFile(file, "not json", "utf8");
      expect(await loadState(file)).toBeNull();

      await writeFile(file, JSON.stringify({ version: 2, phase: "quiet" }), "utf8");
      expect(await loadState(file)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent directory on save", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bot-state-"));
    try {
      const file = path.join(dir, "nested", "deeper", "state.json");
      const s: NotifState = { version: 1, phase: "active", quietSinceMs: null, lastNotifiedAtMs: 7 };
      await saveState(file, s);
      expect(await loadState(file)).toEqual(s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
