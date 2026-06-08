import { useState } from "react";
import { LUNA_PER_NIM, type AppConfig, type QueueItem } from "@radio/shared";

import { boostSong, getBoostIntent } from "../api/client";
import { formatDuration, formatPaid, lunaToNim } from "../lib/format";
import { inNimiqPay } from "../lib/nimiq";
import { payThenConfirm } from "../lib/payFlow";
import { NqIcon } from "./NqIcon";

/**
 * Detail panel for a queued song. All read-only fields come from the already-polled
 * RadioState. In paid mode, an upcoming song (position !== null) can be boosted: pay more
 * NIM to raise its total and jump ahead in the queue.
 */
export function SongDetails({
  item,
  position,
  config,
  onBoosted,
  onClose,
}: {
  item: QueueItem;
  position: number | null;
  config: AppConfig | null;
  onBoosted: () => void;
  onClose: () => void;
}) {
  const minNim = config ? lunaToNim(config.priceLuna) : "1";
  const [amount, setAmount] = useState(minNim);
  const [boosting, setBoosting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canBoost = !!config?.paymentsEnabled && position !== null;

  async function handleBoost() {
    if (boosting) return;
    setError(null);
    setStatus(null);
    if (!inNimiqPay()) {
      // Short-circuit: outside Nimiq Pay the SDK can't pay (it would just time out after ~10s).
      setError("Open this app inside Nimiq Pay to boost.");
      return;
    }

    const amountLuna = Math.round(Number.parseFloat(amount) * LUNA_PER_NIM);
    if (!Number.isFinite(amountLuna) || amountLuna <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setBoosting(true);
    try {
      const intent = await getBoostIntent(item.id);
      if (!intent.success) {
        setError(intent.error);
        return;
      }
      if (amountLuna < intent.minLuna) {
        setError(`Minimum boost is ${lunaToNim(intent.minLuna)} NIM.`);
        return;
      }
      const res = await payThenConfirm({
        recipient: intent.recipientAddress,
        amountLuna,
        orderId: intent.orderId,
        onStatus: setStatus,
        attempt: async (sdkResult) => {
          const r = await boostSong(intent.boostId, sdkResult);
          if (r.success) return { status: "ok" };
          if (r.code === "pending" || r.code === "not_found") return { status: "pending" };
          return { status: "fail", error: r.error };
        },
      });
      if (res.cancelled) {
        setStatus("Payment cancelled.");
      } else if (res.ok) {
        onBoosted();
        onClose();
      } else {
        setError(res.error ?? "Boost failed.");
      }
    } finally {
      setBoosting(false);
    }
  }

  return (
    <div className="details-backdrop" onClick={onClose} role="presentation">
      <div className="details" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Song details">
        <button className="close nq-close-btn" onClick={onClose} aria-label="Close" />
        {item.coverUrl && (
          <img
            className="details-cover"
            src={item.coverUrl}
            alt={`Cover art for ${item.title}`}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        )}
        <h3>{item.title}</h3>
        <dl>
          <dt>Artist</dt>
          <dd>{item.author ?? "—"}</dd>
          <dt>Album</dt>
          <dd>{item.album ?? "—"}</dd>
          <dt>Duration</dt>
          <dd>{typeof item.duration === "number" ? formatDuration(item.duration) : "—"}</dd>
          <dt>Source</dt>
          <dd>
            <a href={item.sourceUrl} target="_blank" rel="noreferrer">
              {item.sourceUrl}
            </a>
          </dd>
          <dt>Submitted by</dt>
          <dd>{item.submittedBy ?? "—"}</dd>
          <dt>Paid</dt>
          <dd>{formatPaid(item.amountPaid)}</dd>
          <dt>Queue position</dt>
          <dd>{position === null ? "Now playing" : `#${position}`}</dd>
        </dl>

        {canBoost && (
          <div className="boost">
            <p className="boost-label"><NqIcon name="bolt" /> Boost this song to move it up the queue</p>
            <div className="boost-row">
              <input
                className="nq-input-box"
                type="number"
                min={minNim}
                step="0.1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={boosting}
                aria-label="Boost amount in NIM"
              />
              <span className="boost-unit">NIM</span>
              <button className="pay-btn boost-pay" onClick={handleBoost} disabled={boosting}>
                {boosting ? "Boosting…" : "Boost"}
              </button>
            </div>
            {!inNimiqPay() && <p className="hint">Open this app inside Nimiq Pay to boost.</p>}
            {status && <p className="hint">{status}</p>}
            {error && <p className="error">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
