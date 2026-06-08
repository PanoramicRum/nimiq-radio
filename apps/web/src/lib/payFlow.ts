import { PaymentCancelledError, sendPayment } from "./nimiq";

export type AttemptStatus = { status: "ok" | "pending" | "fail"; error?: string };

export interface PayThenConfirmResult {
  ok: boolean;
  cancelled: boolean;
  error?: string;
}

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_DELAY_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared pay → poll-confirm flow used by both song submit and boost:
 *  1. send the payment via Nimiq Pay (cancellation is a normal outcome),
 *  2. repeatedly call `attempt(sdkResult)` until it reports ok/fail or attempts run out,
 *     treating "pending" (not yet confirmed on-chain) as retry-after-delay.
 */
export async function payThenConfirm(opts: {
  recipient: string;
  amountLuna: number;
  orderId: string;
  attempt: (sdkResult: string) => Promise<AttemptStatus>;
  onStatus: (msg: string | null) => void;
  attempts?: number;
  delayMs?: number;
}): Promise<PayThenConfirmResult> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;

  let sdkResult: string;
  try {
    opts.onStatus("Confirm the payment in Nimiq Pay…");
    sdkResult = await sendPayment({ recipient: opts.recipient, valueLuna: opts.amountLuna, data: opts.orderId });
  } catch (err) {
    if (err instanceof PaymentCancelledError) return { ok: false, cancelled: true };
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : "Payment failed." };
  }

  for (let i = 1; i <= attempts; i++) {
    opts.onStatus(`Confirming payment… (${i}/${attempts})`);
    const r = await opts.attempt(sdkResult);
    if (r.status === "ok") return { ok: true, cancelled: false };
    if (r.status === "fail") return { ok: false, cancelled: false, error: r.error };
    await sleep(delayMs);
  }
  return { ok: false, cancelled: false, error: "Payment not confirmed in time. If it went through, it'll appear shortly." };
}
