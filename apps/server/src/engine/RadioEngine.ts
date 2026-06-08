import { EventEmitter } from "node:events";

import type { FastifyBaseLogger } from "fastify";
import type { QueueItem, RadioState } from "@radio/shared";

import type { PersistedState, RadioStore } from "./store";

/**
 * The single global, server-authoritative radio.
 *
 * Invariants:
 *  - `current === null` ⟺ the radio is idle ⟺ `queue` is empty.
 *  - `queue` is always kept sorted (amountPaid desc, then createdAt asc — FIFO while
 *    everything is free in Phase 2; ready for paid priority in Phase 4).
 *  - All state changes bump `seq` exactly once and call `persist()`.
 *
 * Concurrency: every mutation here is synchronous with no `await` inside, so mutations
 * cannot interleave on Node's event loop — no mutex is needed in Phase 2. (That changes
 * in Phase 3, where async payment verification precedes enqueue; a serialized writer is
 * introduced then.) `advance()` is guarded by the current track id (each id is unique and
 * is `current` exactly once) so a stale auto-advance timer — or a future client "ended"
 * hint — can never double-skip a song. (We deliberately do NOT guard on `seq`: `seq` bumps
 * on every enqueue, so a song queued mid-playback would otherwise invalidate the running
 * track's advance timer.)
 */
export class RadioEngine {
  private current: QueueItem | null = null;
  private startedAtServerMs: number | null = null;
  private queue: QueueItem[] = [];
  private seq = 0;
  private listeners = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly store: RadioStore,
    private readonly log: FastifyBaseLogger,
  ) {
    this.emitter.setMaxListeners(0); // the WS hub subscribes once, but be safe
    const saved = store.load();
    if (saved) this.restore(saved);
  }

  /** Subscribe to state changes (the WS hub broadcasts these). Returns an unsubscribe fn. */
  onChange(listener: (state: RadioState) => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  /**
   * Update the live listener count. Ephemeral: broadcasts the new state to clients but does
   * NOT bump `seq` or persist (listener churn shouldn't pollute playback-state ordering).
   */
  setListeners(n: number): void {
    if (n === this.listeners) return;
    this.listeners = n;
    this.emitChange();
  }

  /** Add a ready track. Starts immediately if idle; otherwise joins the sorted queue. */
  enqueue(item: QueueItem): void {
    const track: QueueItem = { ...item, status: "ready" };
    if (this.current === null) {
      this.startTrack(track);
    } else {
      this.queue.push(track);
      this.sortQueue();
      this.seq++;
      this.persist();
      this.log.info({ id: track.id, queueLength: this.queue.length }, "radio: enqueued");
    }
  }

  /**
   * Attach background-fetched cover art to a song (now-playing or queued) by id, then
   * re-broadcast. A no-op if the song already left (cover resolves after enqueue). Does not
   * touch the auto-advance timer (keyed by id, unchanged) or the start time.
   */
  setCoverUrl(id: string, coverUrl: string): void {
    const target = this.current?.id === id ? this.current : this.queue.find((q) => q.id === id);
    if (!target || target.coverUrl === coverUrl) return;
    target.coverUrl = coverUrl;
    this.seq++;
    this.persist();
    this.log.info({ id }, "radio: cover art attached");
  }

  /** Immutable snapshot for GET /api/state (and, in Phase 5, WS broadcast). */
  snapshot(): RadioState {
    return {
      current: this.current,
      startedAtServerMs: this.startedAtServerMs,
      queue: [...this.queue],
      paused: false,
      seq: this.seq,
      listeners: this.listeners,
      serverNowMs: Date.now(),
    };
  }

  /**
   * Apply a verified boost to a song's total. Reorders the upcoming queue. The
   * currently-playing track is never preempted: a boost on it updates its displayed
   * total but does not interrupt playback. Returns where it landed.
   */
  boost(queueItemId: string, amountLuna: number): { applied: "queue" | "current" | "gone"; item: QueueItem | null } {
    const queued = this.queue.find((q) => q.id === queueItemId);
    if (queued) {
      queued.amountPaid += amountLuna;
      this.sortQueue();
      this.seq++;
      this.persist();
      this.log.info({ id: queueItemId, amountPaid: queued.amountPaid }, "radio: boosted (reordered queue)");
      return { applied: "queue", item: queued };
    }
    if (this.current?.id === queueItemId) {
      this.current.amountPaid += amountLuna;
      this.seq++;
      this.persist();
      this.log.info({ id: queueItemId, amountPaid: this.current.amountPaid }, "radio: boost applied to now-playing (no preempt)");
      return { applied: "current", item: this.current };
    }
    return { applied: "gone", item: null };
  }

  private startTrack(track: QueueItem): void {
    this.current = { ...track, status: "playing" };
    this.startedAtServerMs = Date.now();
    this.seq++;
    this.persist();
    this.armTimer();
    this.log.info({ id: track.id, title: track.title, duration: track.duration }, "radio: now playing");
  }

  /**
   * Advance to the next track. Idempotent: a no-op unless `expectedTrackId` is still the
   * current track, so a late/duplicate timer (or client "ended" hint) can't double-pop.
   */
  private advance(expectedTrackId: string): void {
    if (this.current?.id !== expectedTrackId) {
      return; // stale trigger — this track is no longer playing
    }
    const next = this.queue.shift() ?? null;
    if (next) {
      this.startTrack(next);
    } else {
      this.current = null;
      this.startedAtServerMs = null;
      this.clearTimer();
      this.seq++;
      this.persist();
      this.log.info("radio: idle (queue empty)");
    }
  }

  private armTimer(): void {
    this.clearTimer();
    const cur = this.current;
    if (!cur || this.startedAtServerMs === null || !cur.duration || cur.duration <= 0) {
      return; // unknown duration -> no auto-advance (acceptable Phase-2 edge)
    }
    const fireAt = this.startedAtServerMs + cur.duration * 1000;
    const delay = Math.max(0, fireAt - Date.now());
    const trackId = cur.id;
    this.timer = setTimeout(() => this.advance(trackId), delay);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => b.amountPaid - a.amountPaid || a.createdAt.localeCompare(b.createdAt));
  }

  private persist(): void {
    const state: PersistedState = {
      current: this.current,
      startedAtServerMs: this.startedAtServerMs,
      queue: this.queue,
      seq: this.seq,
    };
    this.store.persist(state);
    // persist() is the single choke point for every state transition, so this emit
    // covers enqueue / start / advance / boost.
    this.emitChange();
  }

  private emitChange(): void {
    this.emitter.emit("change", this.snapshot());
  }

  /**
   * Rehydrate from a persisted snapshot (a no-op for InMemoryStore on a fresh process).
   * Recomputes elapsed time so a mid-track restart resumes at the right offset, clamped
   * to [0, duration]; if the track already finished, advance through the backlog.
   */
  private restore(saved: PersistedState): void {
    this.current = saved.current;
    this.startedAtServerMs = saved.startedAtServerMs;
    this.queue = saved.queue;
    this.seq = saved.seq;
    this.sortQueue();

    const cur = this.current;
    if (cur && this.startedAtServerMs !== null && cur.duration && cur.duration > 0) {
      const elapsed = (Date.now() - this.startedAtServerMs) / 1000;
      if (elapsed >= cur.duration) {
        this.advance(cur.id); // finished while we were down
        return;
      }
    }
    this.armTimer();
  }
}
