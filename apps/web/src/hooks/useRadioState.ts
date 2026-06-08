import { useEffect, useRef, useState } from "react";
import type { RadioState } from "@radio/shared";

import { RadioClient, type RadioSnapshot } from "../lib/ws";

/**
 * Live radio state over WebSocket (with polling fallback) plus the estimated server-clock
 * offset. `refresh` asks the server for a full resync (used right after a submit/boost).
 */
export function useRadioState(): {
  state: RadioState | null;
  offsetMs: number;
  connected: boolean;
  refresh: () => void;
} {
  const clientRef = useRef<RadioClient | null>(null);
  const [snap, setSnap] = useState<RadioSnapshot>({ state: null, offsetMs: 0, connected: false });

  useEffect(() => {
    const client = new RadioClient();
    clientRef.current = client;
    const unsubscribe = client.subscribe(setSnap);
    client.start();
    return () => {
      unsubscribe();
      client.stop();
      clientRef.current = null;
    };
  }, []);

  return {
    state: snap.state,
    offsetMs: snap.offsetMs,
    connected: snap.connected,
    refresh: () => clientRef.current?.requestResync(),
  };
}
