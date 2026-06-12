import { useState, type FormEvent } from "react";
import type { AppConfig } from "@radio/shared";

import { prepareSong, submitSong } from "../api/client";
import { lunaToNim } from "../lib/format";
import { inNimiqPay } from "../lib/nimiq";
import { payThenConfirm } from "../lib/payFlow";

type Phase = "idle" | "preparing" | "awaitingPay" | "paying";

interface PendingPayment {
  prepareId: string;
  orderId: string;
  priceLuna: number;
  recipientAddress: string;
  title: string;
}

/**
 * Free mode: prepare-song enqueues directly. Paid mode: prepare stages the song and returns
 * a price + order id; the user pays via Nimiq Pay, then we submit and poll until the payment
 * confirms on-chain.
 */
export function SubmitForm({ config, onSubmitted }: { config: AppConfig | null; onSubmitted: () => void }) {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const busy = phase === "preparing" || phase === "paying";

  function reset() {
    setPending(null);
    setPhase("idle");
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || busy) return;

    setError(null);
    setInfo(null);
    setPhase("preparing");
    try {
      const res = await prepareSong(trimmed);
      if (!res.success) {
        setError(res.error);
        setPhase("idle");
        return;
      }
      if (res.mode === "free") {
        setUrl("");
        setInfo("Added to the queue!");
        setPhase("idle");
        onSubmitted();
        return;
      }
      // paid: stage the payment step
      setPending({
        prepareId: res.prepareId,
        orderId: res.orderId,
        priceLuna: res.priceLuna,
        recipientAddress: res.recipientAddress,
        title: res.title,
      });
      setPhase("awaitingPay");
    } catch {
      setError("Could not reach the server. Is it running?");
      setPhase("idle");
    }
  }

  async function handlePay() {
    if (!pending) return;
    setError(null);
    setInfo(null);
    if (!inNimiqPay()) {
      // Short-circuit: outside Nimiq Pay the SDK can't pay (it would just time out after ~10s).
      setError("Open this app inside Nimiq Pay to pay.");
      return;
    }
    setPhase("paying");

    const res = await payThenConfirm({
      recipient: pending.recipientAddress,
      amountLuna: pending.priceLuna,
      orderId: pending.orderId,
      onStatus: setInfo,
      attempt: async (sdkResult) => {
        const r = await submitSong(pending.prepareId, sdkResult);
        if (r.success) return { status: "ok" };
        if (r.code === "pending" || r.code === "not_found") return { status: "pending" };
        return { status: "fail", error: r.error };
      },
    });

    if (res.cancelled) {
      setInfo("Payment cancelled — you can try again.");
      setPhase("awaitingPay");
    } else if (res.ok) {
      setUrl("");
      setInfo("Payment confirmed — your song is in the queue!");
      reset();
      onSubmitted();
    } else {
      setError(res.error ?? "Payment failed.");
      reset();
    }
  }

  const priceNim = pending ? lunaToNim(pending.priceLuna) : config ? lunaToNim(config.priceLuna) : "";
  const addLabel = phase === "preparing" ? "Preparing…" : config?.paymentsEnabled ? "Add song" : "Add to queue";

  return (
    <div className="submit">
      <form className="submit-form" onSubmit={handleAdd}>
        <input
          className="nq-input-box"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="Paste a YouTube, SoundCloud, Bandcamp, or Audius link…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy || pending !== null}
          // No `required`: an empty box is a valid resting state (submission is guarded in JS and
          // the button is disabled when blank). `required` would make the cleared-after-submit
          // field `:user-invalid`, which nimiq-css renders with an orange placeholder.
        />
        <button type="submit" disabled={busy || pending !== null || !url.trim()}>
          {addLabel}
        </button>
      </form>

      {config?.paymentsEnabled && !pending && (
        <p className="hint">Adding a song costs {priceNim} NIM ({config.network}).</p>
      )}
      {phase === "preparing" && <p className="hint">Preparing your song…</p>}

      {pending && (
        <div className="pay-panel">
          <p className="pay-title">
            Ready: <strong>{pending.title}</strong>
          </p>
          <button className="pay-btn" onClick={handlePay} disabled={phase === "paying"}>
            {phase === "paying" ? "Paying…" : `Pay ${priceNim} NIM`}
          </button>
          {!inNimiqPay() && <p className="hint">Open this app inside Nimiq Pay to pay.</p>}
          <button className="link-btn" onClick={reset} disabled={phase === "paying"}>
            Cancel
          </button>
        </div>
      )}

      {info && <p className="hint">{info}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
