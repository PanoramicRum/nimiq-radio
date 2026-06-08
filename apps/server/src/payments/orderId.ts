import { randomBytes } from "node:crypto";

/**
 * A compact order id embedded in the payment transaction's `data` field so the backend
 * can bind a specific on-chain payment to a specific song submission.
 *
 * 6 bytes -> 12 lowercase hex chars: far under the 64-byte basic-tx data cap, and being
 * hex it round-trips unambiguously whether Nimiq Pay encodes `data` as UTF-8 text or as
 * raw hex bytes (the verifier checks both and reports which — see RpcVerifier.matchOrderId).
 */
export function newOrderId(): string {
  return randomBytes(6).toString("hex");
}
