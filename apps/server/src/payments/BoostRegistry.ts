import { randomBytes } from "node:crypto";

import { newOrderId } from "./orderId";

export interface BoostRecord {
  boostId: string;
  orderId: string;
  queueItemId: string;
  minLuna: number;
  createdAt: number;
}

/**
 * In-memory registry of boost intents (paid mode). Mirrors PrepareRegistry: an intent is
 * created when the user starts a boost and consumed when the boost payment is verified.
 */
export class BoostRegistry {
  private readonly records = new Map<string, BoostRecord>();

  constructor(private readonly ttlMs = 30 * 60_000) {}

  create(queueItemId: string, minLuna: number): BoostRecord {
    const record: BoostRecord = {
      boostId: randomBytes(12).toString("hex"),
      orderId: newOrderId(),
      queueItemId,
      minLuna,
      createdAt: Date.now(),
    };
    this.records.set(record.boostId, record);
    return record;
  }

  get(boostId: string): BoostRecord | undefined {
    this.prune();
    return this.records.get(boostId);
  }

  consume(boostId: string): void {
    this.records.delete(boostId);
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, r] of this.records) {
      if (r.createdAt < cutoff) this.records.delete(id);
    }
  }
}
