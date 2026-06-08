import type { QueueItem } from "@radio/shared";

/**
 * The persistence seam for the RadioEngine. Phase 2 uses InMemoryStore (the radio
 * resets on restart). A SQLite-backed store drops in here later with no engine change.
 */
export interface PersistedState {
  current: QueueItem | null;
  startedAtServerMs: number | null;
  queue: QueueItem[];
  seq: number;
}

export interface RadioStore {
  load(): PersistedState | null;
  persist(state: PersistedState): void;
}

/** Holds state only for the lifetime of the process. */
export class InMemoryStore implements RadioStore {
  private state: PersistedState | null = null;

  load(): PersistedState | null {
    return this.state;
  }

  persist(state: PersistedState): void {
    this.state = structuredClone(state);
  }
}
