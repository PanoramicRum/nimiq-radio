import { Buffer } from "node:buffer";

import { NETWORK_ID, type NimiqNetwork } from "@radio/shared";
import type { FastifyBaseLogger } from "fastify";
import {
  getBlockNumber as rpcGetBlockNumber,
  getTransactionByHash as rpcGetTransactionByHash,
  getTransactionFromMempool as rpcGetTransactionFromMempool,
} from "nimiq-rpc-client-ts/http";
import type { HttpRpcResult, Transaction } from "nimiq-rpc-client-ts/types";

import type { PaymentVerifier, VerifyInput, VerifyResult } from "./PaymentVerifier";

/** The RPC surface the verifier needs — injectable so it can be unit-tested without a node. */
export interface RpcDeps {
  getTransactionByHash(p: { hash: string }): Promise<HttpRpcResult<Transaction>>;
  getTransactionFromMempool(p: { hash: string }): Promise<HttpRpcResult<Transaction>>;
  getBlockNumber(): Promise<HttpRpcResult<number>>;
}

export const realRpcDeps: RpcDeps = {
  getTransactionByHash: rpcGetTransactionByHash,
  getTransactionFromMempool: rpcGetTransactionFromMempool,
  getBlockNumber: rpcGetBlockNumber,
};

export interface RpcVerifierOptions {
  network: NimiqNetwork;
  recipientAddress: string;
  minConfirmations: number;
}

const HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * Verifies a payment via a single chain read (the caller retries on "pending"). Asserts ALL
 * of: tx exists in a block, networkId matches, recipient matches our address, value covers
 * the price, the order id is present in recipientData (UTF-8 or hex), and confirmations are
 * sufficient. There is no executionResult field on a basic tx — inclusion in a block with
 * confirmations is the success signal.
 */
export class RpcVerifier implements PaymentVerifier {
  constructor(
    private readonly opts: RpcVerifierOptions,
    private readonly log: FastifyBaseLogger,
    private readonly rpc: RpcDeps = realRpcDeps,
  ) {}

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const hash = normalizeHash(input.sdkResult);
    if (!hash) {
      // The SDK docs say this returns a tx hash; the SDK types hint "serialized transaction".
      // Log the raw value so the first real payment tells us which — then we finalize if needed.
      this.log.warn(
        { sdkResult: input.sdkResult.slice(0, 120), length: input.sdkResult.length },
        "payment: wallet result is not a 64-hex tx hash (see plan Correctness note #1)",
      );
      return { ok: false, code: "bad_result", reason: "Unexpected wallet result (not a transaction hash)." };
    }

    const [found, , tx] = await this.rpc.getTransactionByHash({ hash });
    if (!found || !tx) {
      const [inMempool] = await this.rpc.getTransactionFromMempool({ hash });
      return inMempool
        ? { ok: false, code: "pending", reason: "Payment seen in mempool; waiting for inclusion in a block." }
        : { ok: false, code: "not_found", reason: "Payment transaction not found yet." };
    }

    const expectedNetwork = NETWORK_ID[this.opts.network];
    if (tx.networkId !== expectedNetwork) {
      return { ok: false, code: "wrong_network", reason: `Wrong network (got ${tx.networkId}, expected ${expectedNetwork}).` };
    }
    if (normalizeAddress(tx.to) !== normalizeAddress(this.opts.recipientAddress)) {
      return { ok: false, code: "wrong_recipient", reason: "Payment was sent to the wrong address." };
    }
    if (tx.value < input.requiredLuna) {
      return { ok: false, code: "underpaid", reason: `Paid ${tx.value} Luna but ${input.requiredLuna} is required.` };
    }
    const encoding = matchOrderId(tx.recipientData, input.orderId);
    if (!encoding) {
      return { ok: false, code: "order_mismatch", reason: "Payment is not linked to this song (order id missing)." };
    }

    const confirmations = await this.confirmationsFor(tx);
    if (confirmations < this.opts.minConfirmations) {
      return {
        ok: false,
        code: "pending",
        reason: `Waiting for confirmations (${confirmations}/${this.opts.minConfirmations}).`,
      };
    }

    this.log.info({ hash, encoding, valueLuna: tx.value, from: tx.from, confirmations }, "payment: verified");
    return {
      ok: true,
      txHash: tx.hash,
      encoding,
      payment: {
        txHash: tx.hash,
        senderAddress: tx.from,
        recipientAddress: tx.to,
        amountLuna: tx.value,
        confirmedAt: new Date().toISOString(),
      },
    };
  }

  private async confirmationsFor(tx: Transaction): Promise<number> {
    if (typeof tx.confirmations === "number") return tx.confirmations;
    if (typeof tx.blockNumber !== "number") return 0;
    const [ok, , head] = await this.rpc.getBlockNumber();
    if (!ok || typeof head !== "number") return 0;
    return Math.max(0, head - tx.blockNumber + 1);
  }
}

function normalizeHash(s: string): string | null {
  const t = s.trim();
  return HASH_RE.test(t) ? t.toLowerCase() : null;
}

/** NQ addresses are uppercase with spaces; compare without whitespace/case. */
function normalizeAddress(addr: string): string {
  return addr.replace(/\s+/g, "").toUpperCase();
}

/**
 * Match the on-chain recipientData against the order id under either encoding the wallet
 * might use: UTF-8 text (hex of the ascii bytes) or raw hex (the id as-is). Returns which
 * matched, or null. (The id is hex, so the two candidates differ in length and never collide.)
 */
function matchOrderId(recipientData: string, orderId: string): "utf8" | "hex" | null {
  const rd = recipientData.toLowerCase();
  const utf8Hex = Buffer.from(orderId, "utf8").toString("hex").toLowerCase();
  if (rd === utf8Hex) return "utf8";
  if (rd === orderId.toLowerCase()) return "hex";
  return null;
}
