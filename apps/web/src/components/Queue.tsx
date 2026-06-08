import type { QueueItem } from "@radio/shared";

import { formatPaid } from "../lib/format";

export function Queue({ items, onSelect }: { items: QueueItem[]; onSelect: (item: QueueItem) => void }) {
  return (
    <section className="queue">
      <h3>Up next{items.length > 0 ? ` (${items.length})` : ""}</h3>
      {items.length === 0 ? (
        <p className="empty">Queue is empty — add a song.</p>
      ) : (
        <ol className="queue-list">
          {items.map((item, i) => (
            <li key={item.id}>
              <button className="queue-item" onClick={() => onSelect(item)}>
                <span className="pos">{i + 1}</span>
                <span className="qi-main">
                  <span className="qi-title">{item.title}</span>
                  {item.author && <span className="qi-author">{item.author}</span>}
                </span>
                <span className="qi-paid">{formatPaid(item.amountPaid)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
