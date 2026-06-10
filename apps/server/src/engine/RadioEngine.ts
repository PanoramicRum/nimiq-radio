import { EventEmitter } from "node:events";

import type { FastifyBaseLogger } from "fastify";
import type { QueueItem, RadioState } from "@radio/shared";

import type { FillerSource } from "../filler/FillerSource";
import type { PersistedState, RadioStore } from "./store";

/**
 * The single global, server-authoritative radio.
 *
 * Invariants:
 *  - With a filler library present (Phase 8) the radio is never silent: when no user song is
 *    queued it plays a Creative-Commons filler track. `current === null` only when there is no
 *    filler available (empty/missing library) — that is the lone remaining idle state.
 *  - `queue` holds only USER songs (free or paid). Filler is summoned on demand into `current`
 *    and never enters the queue, so the upcoming list stays purely user-submitted.
 *  - `queue` is always kept sorted (amountPaid desc, then createdAt asc — FIFO within a tier).
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
    private readonly fillerSource?: FillerSource,
  ) {
    this.emitter.setMaxListeners(0); // the WS hub subscribes once, but be safe
    const saved = store.load();
    if (saved) this.restore(saved);
  }

  /**
   * Ensure something is playing — start a filler track if the radio is idle. Called once after
   * construction (the filler source is wired in app.ts). A no-op when already playing or when no
   * filler is available (then the radio stays idle, exactly as before Phase 8).
   */
  ensurePlaying(): void {
    if (this.current !== null) return;
    if (!this.fillerSource || this.fillerSource.isEmpty()) return;
    this.startFiller();
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

  /**
   * Add a ready USER track. Starts immediately if idle; if a Creative-Commons filler is playing
   * it preempts the filler (filler is disposable and yields to users); otherwise it joins the
   * sorted queue. A user/paid track that is currently playing is never preempted.
   */
  enqueue(item: QueueItem): void {
    const track: QueueItem = { ...item, status: "ready", isRadio: false };
    if (this.current === null) {
      this.startTrack(track);
    } else if (this.current.isRadio) {
      // Filler is playing — a user song always wins. Drop the filler (never requeued) and start
      // the user song now. startTrack() clears the filler's pending timer, and a late filler
      // timer is also neutralized by advance()'s current-id guard.
      this.log.info({ id: track.id, filler: this.current.id }, "radio: user song preempts filler");
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
      if (this.current.isRadio) {
        // Filler isn't a paid slot — it can't be boosted (and the UI never offers it).
        this.log.info({ id: queueItemId }, "radio: boost ignored (filler is not boostable)");
        return { applied: "gone", item: null };
      }
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
    this.log.info(
      { id: track.id, title: track.title, duration: track.duration, isRadio: track.isRadio ?? false },
      "radio: now playing",
    );
  }

  /**
   * Start a Creative-Commons filler track so the radio is never silent. The filler library yields
   * the next track (genre-walked); if none is available we fall back to true idle.
   */
  private startFiller(): void {
    const d = this.fillerSource?.next();
    if (!d) {
      this.goIdle();
      return;
    }
    this.startTrack({
      id: d.id,
      sourceUrl: "",
      trackUrl: d.trackUrl,
      title: d.title,
      author: d.author,
      duration: d.duration,
      amountPaid: 0,
      createdAt: new Date().toISOString(),
      status: "ready",
      isRadio: true,
    });
  }

  /** Go silent — only reached when there is no filler to play. */
  private goIdle(): void {
    this.current = null;
    this.startedAtServerMs = null;
    this.clearTimer();
    this.seq++;
    this.persist();
    this.log.info("radio: idle (no user songs, no filler available)");
  }

  /**
   * Advance to the next track. Idempotent: a no-op unless `expectedTrackId` is still the
   * current track, so a late/duplicate timer (or client "ended" hint) can't double-pop. When the
   * user queue is empty it summons a filler track rather than going silent.
   */
  private advance(expectedTrackId: string): void {
    if (this.current?.id !== expectedTrackId) {
      return; // stale trigger — this track is no longer playing
    }
    const next = this.queue.shift() ?? null;
    if (next) {
      this.startTrack(next);
    } else {
      this.startFiller();
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
   *
   * Filler is never resumed across restarts: a persisted filler may reference an audio file a
   * later deploy removed, and resuming a stale offset is pointless — so a persisted-filler (or
   * idle) state summons a fresh filler instead. Filler should never be in the queue, but we strip
   * it defensively in case an older persisted snapshot put it there.
   */
  private restore(saved: PersistedState): void {
    this.queue = saved.queue.filter((q) => !q.isRadio);
    this.seq = saved.seq;
    this.sortQueue();

    const cur = saved.current && !saved.current.isRadio ? saved.current : null;
    this.current = cur;
    this.startedAtServerMs = cur ? saved.startedAtServerMs : null;

    if (cur && this.startedAtServerMs !== null && cur.duration && cur.duration > 0) {
      const elapsed = (Date.now() - this.startedAtServerMs) / 1000;
      if (elapsed >= cur.duration) {
        this.advance(cur.id); // finished while we were down -> next user song or filler
        return;
      }
    }
    if (cur) {
      this.armTimer();
    } else if (this.fillerSource && !this.fillerSource.isEmpty()) {
      this.startFiller(); // persisted idle / persisted filler -> start a fresh filler
    }
  }
}
