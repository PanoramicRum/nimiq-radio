import type { Db } from "../db";
import type { PersistedState, RadioStore } from "./store";

/**
 * RadioStore backed by SQLite: the whole engine snapshot is stored as JSON in a single
 * row. Writes are synchronous (better-sqlite3), preserving the engine's "no await inside a
 * mutation" invariant. On boot the engine rehydrates from load() and resumes mid-track.
 */
export class SqliteStore implements RadioStore {
  private readonly selectStmt;
  private readonly upsertStmt;

  constructor(db: Db) {
    this.selectStmt = db.prepare("SELECT state FROM radio_state WHERE id = 1");
    this.upsertStmt = db.prepare(
      "INSERT INTO radio_state (id, state, updated_at) VALUES (1, @state, @updatedAt) " +
        "ON CONFLICT(id) DO UPDATE SET state = @state, updated_at = @updatedAt",
    );
  }

  load(): PersistedState | null {
    const row = this.selectStmt.get() as { state: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.state) as PersistedState;
    } catch {
      return null;
    }
  }

  persist(state: PersistedState): void {
    this.upsertStmt.run({ state: JSON.stringify(state), updatedAt: new Date().toISOString() });
  }
}
