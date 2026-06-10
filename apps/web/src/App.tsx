import { useState } from "react";
import type { QueueItem, RadioState } from "@radio/shared";

import { NowPlaying } from "./components/NowPlaying";
import { Queue } from "./components/Queue";
import { RadioPlayer } from "./components/RadioPlayer";
import { SongDetails } from "./components/SongDetails";
import { SubmitForm } from "./components/SubmitForm";
import { ThemeToggle } from "./components/ThemeToggle";
import { useConfig } from "./hooks/useConfig";
import { useRadioState } from "./hooks/useRadioState";

export function App() {
  const { state, offsetMs, connected, refresh } = useRadioState();
  const config = useConfig();
  const [selected, setSelected] = useState<QueueItem | null>(null);

  return (
    <main className="app">
      <header className="app-header">
        <div className="brand">
          <h1>Nimiq Radio</h1>
        </div>
        <div className="header-actions">
          <LiveBadge listeners={state?.listeners ?? 0} connected={connected} />
          <ThemeToggle />
        </div>
      </header>
      <p className="tagline">Add a song, everyone will hear it with you</p>

      <SubmitForm config={config} onSubmitted={refresh} />

      <NowPlaying current={state?.current ?? null} onSelect={setSelected} />
      <RadioPlayer
        current={state?.current ?? null}
        startedAtServerMs={state?.startedAtServerMs ?? null}
        offsetMs={offsetMs}
      />
      <Queue items={state?.queue ?? []} onSelect={setSelected} />

      {selected && (
        <SongDetails
          item={selected}
          position={positionOf(state, selected)}
          config={config}
          onBoosted={refresh}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}

/** Live listener count + a glowing red LIVE badge, shown top-right. */
function LiveBadge({ listeners, connected }: { listeners: number; connected: boolean }) {
  return (
    <div className={connected ? "live-badge" : "live-badge live-badge--off"}>
      <span className="live-badge__count" title="People listening right now">
        <span aria-hidden>🎧</span> {listeners}
      </span>
      <span className="live-badge__live">
        <span className="live-badge__dot" aria-hidden /> LIVE
      </span>
    </div>
  );
}

/** 1-based queue position, or null if the item is the now-playing track. */
function positionOf(state: RadioState | null, item: QueueItem): number | null {
  if (!state) return null;
  if (state.current?.id === item.id) return null;
  const idx = state.queue.findIndex((q) => q.id === item.id);
  return idx >= 0 ? idx + 1 : null;
}
