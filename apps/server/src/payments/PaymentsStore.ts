import type { FastifyBaseLogger } from "fastify";

import type { Db } from "../db";

export interface PaymentRecord {
  txHash: string;
  orderId: string;
  trackId: string;
  kind: "submit" | "boost";
  senderAddress: string;
  recipientAddress: string;
  amountLuna: number;
}

/**
 * Records verified payments and blocks reusing one for more than one song/boost.
 * In-memory Sets give O(1) lookups; when a Db is provided they're seeded from the payments
 * table on boot and every record is persisted — so replay protection survives a restart
 * (an in-memory-only guard would forget consumed tx hashes and allow replays after a crash).
 */
export class PaymentsStore {
  private readonly txHashes = new Set<string>();
  private readonly orderIds = new Set<string>();
  private readonly insertStmt;

  constructor(
    db?: Db,
    private readonly log?: FastifyBaseLogger,
  ) {
    if (db) {
      this.insertStmt = db.prepare(
        "INSERT INTO payments (tx_hash, order_id, track_id, kind, sender_address, recipient_address, amount_luna, created_at) " +
          "VALUES (@txHash, @orderId, @trackId, @kind, @senderAddress, @recipientAddress, @amountLuna, @createdAt)",
      );
      const rows = db.prepare("SELECT tx_hash, order_id FROM payments").all() as Array<{ tx_hash: string; order_id: string }>;
      for (const r of rows) {
        this.txHashes.add(r.tx_hash.toLowerCase());
        this.orderIds.add(r.order_id.toLowerCase());
      }
    }
  }

  isConsumed(txHash: string, orderId: string): boolean {
    return this.txHashes.has(txHash.toLowerCase()) || this.orderIds.has(orderId.toLowerCase());
  }

  record(p: PaymentRecord): void {
    this.txHashes.add(p.txHash.toLowerCase());
    this.orderIds.add(p.orderId.toLowerCase());
    if (this.insertStmt) {
      try {
        this.insertStmt.run({ ...p, createdAt: new Date().toISOString() });
      } catch (err) {
        // A UNIQUE/constraint violation just means "already recorded" (concurrent retry) and
        // is safe to ignore. Anything else (disk full, corruption) is a real operational
        // problem — surface it instead of silently letting the DB drift from the in-memory guard.
        const code = (err as { code?: string }).code ?? "";
        if (code.startsWith("SQLITE_CONSTRAINT")) return;
        this.log?.error({ err, txHash: p.txHash }, "payments: failed to persist verified payment");
      }
    }
  }
}
