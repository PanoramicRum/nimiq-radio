import type { KeyboardEvent } from "react";
import type { QueueItem } from "@radio/shared";

import { formatDuration, formatPaid, shortAddress } from "../lib/format";
import { NqIcon } from "./NqIcon";

export function NowPlaying({ current, onSelect }: { current: QueueItem | null; onSelect?: (item: QueueItem) => void }) {
  if (!current) {
    return (
      <section className="now-playing idle">
        <p className="np-label nq-label">Now playing</p>
        <p className="idle-text">Nothing playing — submit a song to start the radio.</p>
      </section>
    );
  }

  const open = onSelect ? () => onSelect(current) : undefined;
  const onKeyDown = (e: KeyboardEvent) => {
    if (open && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      open();
    }
  };

  return (
    <section className="now-playing">
      <p className="np-label nq-label">Now playing</p>
      <div
        className={open ? "np-card np-card--clickable" : "np-card"}
        {...(open ? { role: "button", tabIndex: 0, onClick: open, onKeyDown, "aria-label": `Show details for ${current.title}` } : {})}
      >
        <div className="np-cover">
          <span className="np-cover-placeholder" aria-hidden="true"><NqIcon name="music-note" /></span>
          {current.coverUrl && (
            <img
              src={current.coverUrl}
              alt={`Cover art for ${current.title}`}
              loading="lazy"
              decoding="async"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          )}
        </div>
        <div className="np-text">
          <h2>{current.title}</h2>
          {current.author && (
            <p className="meta">
              {current.author}
              {current.album ? ` · ${current.album}` : ""}
            </p>
          )}
          <p className="meta sub">
            {current.submittedBy ? `by ${shortAddress(current.submittedBy)} · ` : ""}
            {formatPaid(current.amountPaid)}
            {typeof current.duration === "number" ? ` · ${formatDuration(current.duration)}` : ""}
          </p>
          {open && <span className="np-details-hint">Tap for details <NqIcon name="chevron-right" /></span>}
        </div>
      </div>
    </section>
  );
}
