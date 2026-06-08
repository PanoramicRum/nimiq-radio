import { useEffect, useRef, useState } from "react";
import type { QueueItem } from "@radio/shared";

import { livePositionSec } from "../lib/clockSync";
import { NqIcon } from "./NqIcon";
import { TapToListen } from "./TapToListen";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const CORRECT_EVERY_MS = 2000; // how often we nudge toward the server position
const HARD_SEEK_SEC = 0.75; // drift beyond this -> jump
const NUDGE_SEC = 0.12; // drift beyond this (but under hard-seek) -> playbackRate nudge

/**
 * One persistent <audio> kept aligned to the server clock.
 *  - On track change: load the new src, seek to the live position, and (once the user has
 *    tapped to listen) play.
 *  - A 2s controller corrects drift: hard-seek for big gaps, gentle playbackRate nudging for
 *    small ones — so the correction is inaudible most of the time.
 *  - On tab/app resume (visibilitychange) it hard-seeks back to live.
 * Native controls are hidden so listeners can't scrub away from "live".
 */
export function RadioPlayer({
  current,
  startedAtServerMs,
  offsetMs,
}: {
  current: QueueItem | null;
  startedAtServerMs: number | null;
  offsetMs: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);

  // Latest sync inputs in refs so the interval + listeners read fresh values.
  const startedRef = useRef(false);
  const startedAtRef = useRef(startedAtServerMs);
  const offsetRef = useRef(offsetMs);
  startedAtRef.current = startedAtServerMs;
  offsetRef.current = offsetMs;

  function targetSec(): number | null {
    if (startedAtRef.current === null) return null;
    return livePositionSec(startedAtRef.current, offsetRef.current);
  }

  function hardSeek(): void {
    const audio = audioRef.current;
    const target = targetSec();
    if (!audio || target === null) return;
    try {
      audio.currentTime = target;
      audio.playbackRate = 1;
    } catch {
      /* not seekable yet */
    }
  }

  // Load a new track (keyed on id only, so tapping doesn't reload mid-song).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!current) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      return;
    }

    audio.src = `${API_BASE}${current.trackUrl}`;
    audio.load();
    const onReady = () => {
      hardSeek();
      if (startedRef.current) void audio.play().catch(() => undefined);
    };
    audio.addEventListener("loadedmetadata", onReady, { once: true });
    return () => audio.removeEventListener("loadedmetadata", onReady);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Continuous drift correction while playing.
  useEffect(() => {
    const id = window.setInterval(() => {
      const audio = audioRef.current;
      const target = targetSec();
      if (!audio || target === null || !startedRef.current || audio.paused || audio.readyState < 2) return;
      const drift = audio.currentTime - target; // >0 = ahead of server
      if (Math.abs(drift) > HARD_SEEK_SEC) {
        try {
          audio.currentTime = target;
        } catch {
          /* not seekable yet */
        }
        audio.playbackRate = 1;
      } else if (drift > NUDGE_SEC) {
        audio.playbackRate = 0.97; // ahead -> slow down
      } else if (drift < -NUDGE_SEC) {
        audio.playbackRate = 1.03; // behind -> speed up
      } else {
        audio.playbackRate = 1;
      }
    }, CORRECT_EVERY_MS);
    return () => window.clearInterval(id);
  }, []);

  // Re-align immediately when the tab/app becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && startedRef.current) hardSeek();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleTap() {
    const audio = audioRef.current;
    if (!audio) return;
    startedRef.current = true;
    setStarted(true);
    hardSeek();
    try {
      await audio.play();
    } catch {
      /* user can tap again */
    }
  }

  function toggleMute() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setMuted(audio.muted);
  }

  return (
    <div className="radio-player">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} preload="auto" />
      {!started ? (
        <TapToListen onTap={handleTap} disabled={!current} />
      ) : (
        <div className="live-bar">
          <span className="live-dot" aria-hidden />
          <span className="live-text">{current ? "LIVE" : "waiting for the next song…"}</span>
          <button className="mute-btn" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>
            <NqIcon name={muted ? "volume-x" : "volume-2"} />
          </button>
        </div>
      )}
    </div>
  );
}
