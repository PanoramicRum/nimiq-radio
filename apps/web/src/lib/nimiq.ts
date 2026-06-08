import { init, type NimiqProvider } from "@nimiq/mini-app-sdk";

/**
 * Thin wrapper over the Nimiq Pay Mini App SDK.
 *
 * Notes from the SDK types (see plan Correctness note #1):
 *  - sendBasicTransactionWithData resolves to `string | ErrorResponse`. The string is
 *    documented as the tx hash but typed as "the serialized transaction" — we pass it to
 *    the backend as-is and let the server normalize/verify (and log which it actually is).
 *  - Some builds may THROW (PermissionDenied / InvalidTransaction) instead of returning an
 *    ErrorResponse, so we handle both. User cancellation is a normal outcome, not an error.
 */

let providerPromise: Promise<NimiqProvider> | null = null;

export function getProvider(timeout = 10_000): Promise<NimiqProvider> {
  if (!providerPromise) {
    providerPromise = init({ timeout }).catch((err: unknown) => {
      providerPromise = null; // allow retry after a failed init
      throw err;
    });
  }
  return providerPromise;
}

/** True if the app is running inside Nimiq Pay (the provider is injected). */
export function inNimiqPay(): boolean {
  return typeof window !== "undefined" && (window.nimiqPay !== undefined || window.nimiq !== undefined);
}

export class PaymentCancelledError extends Error {
  constructor(message = "Payment cancelled.") {
    super(message);
    this.name = "PaymentCancelledError";
  }
}
export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

function isErrorResponse(v: unknown): v is { error: { type: string; message: string } } {
  return typeof v === "object" && v !== null && "error" in v;
}

function looksCancelled(text: string): boolean {
  return /permission|denied|reject|cancel|abort/i.test(text);
}

/**
 * Best-effort human-readable message from an unknown thrown/returned value. Some Nimiq Pay
 * SDK builds reject with a plain object (ErrorResponse) instead of an Error, so a naive
 * String(err) would surface "[object Object]" to the user — this digs out a real message.
 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (isErrorResponse(err)) return err.error.message || err.error.type || "";
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

/** Send a NIM payment with an attached order id. Returns the raw SDK result string. */
export async function sendPayment(params: { recipient: string; valueLuna: number; data: string }): Promise<string> {
  const provider = await getProvider();

  let result: string | { error: { type: string; message: string } };
  try {
    result = await provider.sendBasicTransactionWithData({
      recipient: params.recipient,
      value: params.valueLuna,
      data: params.data,
    });
  } catch (err) {
    const msg = errMessage(err);
    throw looksCancelled(msg)
      ? new PaymentCancelledError(msg || "Payment cancelled.")
      : new PaymentError(msg || "Payment failed.");
  }

  if (isErrorResponse(result)) {
    const { type, message } = result.error;
    throw looksCancelled(`${type} ${message}`)
      ? new PaymentCancelledError(message || "Payment cancelled.")
      : new PaymentError(message || "Payment failed.");
  }
  return result;
}
