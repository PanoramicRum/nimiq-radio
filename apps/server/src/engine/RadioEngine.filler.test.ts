import type { QueueItem } from "@radio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FillerDescriptor, FillerSource } from "../filler/FillerSource";
import { RadioEngine } from "./RadioEngine";
import { InMemoryStore } from "./store";

// The engine only ever calls log.info — a no-op stub is enough.
const log = { info() {}, warn() {}, error() {} } as never;

/** Yields filler-1, filler-2, … on each next() (or null when `empty`). */
class StubFiller implements FillerSource {
  count = 0;
  constructor(
    private readonly empty = false,
    private readonly duration = 100,
  ) {}
  isEmpty(): boolean {
    return this.empty;
  }
  next(): FillerDescriptor | null {
    if (this.empty) return null;
    const n = ++this.count;
    return { id: `filler-${n}`, trackUrl: `/static/library/f${n}.mp3`, title: `Filler ${n}`, author: "Radio", duration: this.duration, genre: "ambient" };
  }
}

function userSong(id: string, opts: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    sourceUrl: "https://example.com/v",
    trackUrl: `/static/tracks/${id}.mp3`,
    title: id,
    amountPaid: 0,
    createdAt: new Date().toISOString(),
    status: "ready",
    ...opts,
  };
}

// Fake timers keep the auto-advance setTimeout deterministic and leak-free.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RadioEngine filler", () => {
  it("ensurePlaying() starts a filler when idle", () => {
    const engine = new RadioEngine(new InMemoryStore(), log, new StubFiller());
    engine.ensurePlaying();
    const s = engine.snapshot();
    expect(s.current?.isRadio).toBe(true);
    expect(s.current?.id).toBe("filler-1");
  });

  it("a user song preempts a playing filler immediately and the filler is discarded", () => {
    const engine = new RadioEngine(new InMemoryStore(), log, new StubFiller());
    engine.ensurePlaying(); // filler-1 playing
    engine.enqueue(userSong("u1"));
    const s = engine.snapshot();
    expect(s.current?.id).toBe("u1");
    expect(s.current?.isRadio).toBe(false);
    expect(s.queue).toHaveLength(0); // filler not requeued
  });

  it("never preempts a playing USER song; a second user song queues", () => {
    const engine = new RadioEngine(new InMemoryStore(), log, new StubFiller());
    engine.ensurePlaying();
    engine.enqueue(userSong("u1")); // preempts filler -> u1 playing
    engine.enqueue(userSong("u2"));
    const s = engine.snapshot();
    expect(s.current?.id).toBe("u1");
    expect(s.queue.map((q) => q.id)).toEqual(["u2"]);
  });

  it("preserves paid ordering (amountPaid desc, createdAt asc) above filler", () => {
    const engine = new RadioEngine(new InMemoryStore(), log, new StubFiller());
    engine.ensurePlaying();
    engine.enqueue(userSong("first")); // preempts -> first playing
    engine.enqueue(userSong("cheap", { amountPaid: 100, createdAt: "2026-01-01T00:00:02Z" }));
    engine.enqueue(userSong("rich", { amountPaid: 500, createdAt: "2026-01-01T00:00:03Z" }));
    engine.enqueue(userSong("free", { amountPaid: 0, createdAt: "2026-01-01T00:00:01Z" }));
    expect(engine.snapshot().queue.map((q) => q.id)).toEqual(["rich", "cheap", "free"]);
  });

  it("rejects a boost aimed at a filler (it isn't a paid slot)", () => {
    const engine = new RadioEngine(new InMemoryStore(), log, new StubFiller());
    engine.ensurePlaying(); // filler-1
    const r = engine.boost("filler-1", 100);
    expect(r.applied).toBe("gone");
    expect(engine.snapshot().current?.amountPaid).toBe(0);
  });

  it("when the last user song ends, a filler resumes", () => {
    const engine = new RadioEngine(new InMemoryStore(), log, new StubFiller(false, 100));
    engine.ensurePlaying(); // filler-1
    engine.enqueue(userSong("u1", { duration: 2 })); // preempts -> u1 (2s)
    expect(engine.snapshot().current?.id).toBe("u1");
    vi.advanceTimersByTime(2000); // u1 ends
    const s = engine.snapshot();
    expect(s.current?.isRadio).toBe(true);
    expect(s.current?.id).toBe("filler-2");
  });

  it("loops filler indefinitely when no user songs arrive", () => {
    const engine = new RadioEngine(new InMemoryStore(), log, new StubFiller(false, 100));
    engine.ensurePlaying();
    expect(engine.snapshot().current?.id).toBe("filler-1");
    vi.advanceTimersByTime(100_000); // filler-1 ends
    expect(engine.snapshot().current?.id).toBe("filler-2");
  });

  it("falls back to idle (old behavior) when no filler is available", () => {
    const engine = new RadioEngine(new InMemoryStore(), log); // no filler source
    engine.ensurePlaying();
    expect(engine.snapshot().current).toBeNull();
    engine.enqueue(userSong("u1")); // still starts immediately when idle
    expect(engine.snapshot().current?.id).toBe("u1");
  });

  it("goes idle after a user song ends when the filler library is empty", () => {
    const engine = new RadioEngine(new InMemoryStore(), log, new StubFiller(true));
    engine.ensurePlaying();
    expect(engine.snapshot().current).toBeNull();
    engine.enqueue(userSong("u1", { duration: 2 }));
    expect(engine.snapshot().current?.id).toBe("u1");
    vi.advanceTimersByTime(2000);
    expect(engine.snapshot().current).toBeNull(); // empty library -> idle, no crash
  });

  it("restore replaces a persisted filler with a fresh one", () => {
    const store = new InMemoryStore();
    store.persist({
      current: { id: "old-filler", sourceUrl: "", trackUrl: "/static/library/old.mp3", title: "Old", duration: 100, amountPaid: 0, createdAt: "2026-01-01T00:00:00Z", status: "playing", isRadio: true },
      startedAtServerMs: Date.now(),
      queue: [],
      seq: 5,
    });
    const engine = new RadioEngine(store, log, new StubFiller());
    const s = engine.snapshot();
    expect(s.current?.isRadio).toBe(true);
    expect(s.current?.id).toBe("filler-1"); // fresh, not the stale persisted one
  });

  it("restore resumes a user song and strips any filler leaked into the queue", () => {
    const store = new InMemoryStore();
    store.persist({
      current: userSong("u-cur", { duration: 100_000, status: "playing" }),
      startedAtServerMs: Date.now(),
      queue: [userSong("leaked", { isRadio: true }), userSong("real-user", { amountPaid: 50, createdAt: "2026-01-01T00:00:01Z" })],
      seq: 9,
    });
    const engine = new RadioEngine(store, log, new StubFiller());
    const s = engine.snapshot();
    expect(s.current?.id).toBe("u-cur");
    expect(s.queue.map((q) => q.id)).toEqual(["real-user"]); // leaked filler removed
  });
});
