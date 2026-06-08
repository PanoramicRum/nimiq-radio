import { randomBytes } from "node:crypto";

import type { PreparedTrack } from "../media/worker";
import { newOrderId } from "./orderId";

export interface PreparedRecord {
  prepareId: string;
  orderId: string;
  priceLuna: number;
  track: PreparedTrack;
  createdAt: number;
}

/**
 * In-memory registry of songs that have been downloaded but not yet paid for (paid mode).
 * A record is created at prepare time and consumed at submit time. Records expire after a
 * TTL so abandoned prepares don't leak. (Persistence — surviving restart — lands with SQLite.)
 */
export class PrepareRegistry {
  private readonly records = new Map<string, PreparedRecord>();

  constructor(private readonly ttlMs = 30 * 60_000) {}

  create(track: PreparedTrack, priceLuna: number): PreparedRecord {
    const record: PreparedRecord = {
      prepareId: randomBytes(12).toString("hex"),
      orderId: newOrderId(),
      priceLuna,
      track,
      createdAt: Date.now(),
    };
    this.records.set(record.prepareId, record);
    return record;
  }

  get(prepareId: string): PreparedRecord | undefined {
    this.prune();
    return this.records.get(prepareId);
  }

  consume(prepareId: string): void {
    this.records.delete(prepareId);
  }

  /** Track ids of staged-but-unpaid songs — cleanup must not delete their files. */
  stagedTrackIds(): Set<string> {
    this.prune();
    const ids = new Set<string>();
    for (const r of this.records.values()) ids.add(r.track.id);
    return ids;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, r] of this.records) {
      if (r.createdAt < cutoff) this.records.delete(id);
    }
  }
}
