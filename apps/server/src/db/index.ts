import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type Db = Database.Database;

/**
 * Open (and initialize) the SQLite database used for restart survival + durable replay
 * protection. WAL mode keeps the synchronous engine writes cheap. Tables are created
 * idempotently — no migration tooling needed for this prototype's two tables.
 */
export function openDb(dbPath: string): Db {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS radio_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      tx_hash TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      track_id TEXT,
      kind TEXT NOT NULL,
      sender_address TEXT,
      recipient_address TEXT,
      amount_luna INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}
