import type { PaymentInfo } from "@radio/shared";

export type VerifyFailureCode =
  | "pending" // not yet on-chain or not enough confirmations — retry shortly
  | "not_found"
  | "wrong_recipient"
  | "underpaid"
  | "wrong_network"
  | "order_mismatch"
  | "bad_result"; // the wallet returned something we can't interpret as a tx hash

export type VerifyResult =
  | { ok: true; txHash: string; payment: PaymentInfo; encoding: "utf8" | "hex" }
  | { ok: false; code: VerifyFailureCode; reason: string };

export interface VerifyInput {
  /** Raw string returned by the Mini App SDK's sendBasicTransactionWithData. */
  sdkResult: string;
  orderId: string;
  requiredLuna: number;
}

/**
 * Verifies a NIM payment entirely from on-chain data — the frontend is never trusted for
 * amount, sender, or recipient.
 */
export interface PaymentVerifier {
  verify(input: VerifyInput): Promise<VerifyResult>;
}
