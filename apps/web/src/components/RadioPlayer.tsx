import { useEffect, useRef, useState } from "react";
import type { QueueItem } from "@radio/shared";

import { livePositionSec } from "../lib/clockSync";
import { NqIcon } from "./NqIcon";
import { TapToListen } from "./TapToListen";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const CORRECT_EVERY_MS = 2000; // how often we nudge toward the server position
const HARD_SEEK_SEC = 1.25; // drift beyond this -> jump (audible skip, so kept rare)
const NUDGE_SEC = 0.2; // deadband: drift under this is ignored; above (but under hard-seek) -> gentle nudge
const RATE_SLOW = 0.985; // ahead of server -> slow down ~1.5% (gentle; ±3% was an audible pitch wobble)
const RATE_FAST = 1.015; // behind server -> speed up ~1.5%
const VISIBILITY_RESEEK_SEC = 0.5; // on tab/app resume, only hard-seek if drift exceeds this

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
  // Reflects whether the <audio> is actually producing sound. Driven by the element's play/pause
  // events so we can offer a "play" control after the OS/another app steals audio focus (common in
  // the mobile WebView): there's no "pause" button — a live radio is either playing or you tap to
  // (re)join it.
  const [playing, setPlaying] = useState(false);

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
        audio.playbackRate = RATE_SLOW; // ahead -> slow down gently
      } else if (drift < -NUDGE_SEC) {
        audio.playbackRate = RATE_FAST; // behind -> speed up gently
      } else {
        audio.playbackRate = 1;
      }
    }, CORRECT_EVERY_MS);
    return () => window.clearInterval(id);
  }, []);

  // Track real playback so the UI can offer a play control when the stream gets paused (e.g. another
  // app grabbed audio focus). The pause→false transition is debounced because swapping the <audio>
  // src on a track change fires a momentary 'pause' we don't want to surface.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let pauseTimer: number | undefined;
    const clearPauseTimer = () => {
      if (pauseTimer !== undefined) {
        window.clearTimeout(pauseTimer);
        pauseTimer = undefined;
      }
    };
    const onPlay = () => {
      clearPauseTimer();
      setPlaying(true);
    };
    const onPause = () => {
      clearPauseTimer();
      pauseTimer = window.setTimeout(() => setPlaying(false), 400);
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("playing", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      clearPauseTimer();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("playing", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, []);

  // Re-align when the tab/app becomes visible again — but only hard-seek if we actually drifted
  // far while away; small drift is left to the gentle loop so resuming isn't an audible jump.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !startedRef.current) return;
      const audio = audioRef.current;
      const target = targetSec();
      if (!audio || target === null) return;
      if (Math.abs(audio.currentTime - target) > VISIBILITY_RESEEK_SEC) hardSeek();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Media Session: lock-screen now-playing + background continuity ──
  // Declaring an active media session is what lets audio continue across track changes while the
  // phone is locked: without it the next track's play() is blocked by the autoplay policy in the
  // background. It also surfaces the title / cover / play-pause on the lock screen.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!current) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const artwork = current.coverUrl ? [{ src: `${location.origin}${current.coverUrl}`, sizes: "512x512" }] : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.isRadio ? "Added by the radio" : current.author ?? "",
        album: current.album ?? "Nimiq Radio",
        artwork,
      });
    } catch {
      /* MediaMetadata unsupported */
    }
  }, [current?.id, current?.coverUrl, current?.title, current?.author, current?.album, current?.isRadio]);

  // Keep the OS playback state in sync (drives lock-screen controls + background-audio privileges).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = !current ? "none" : playing ? "playing" : "paused";
  }, [playing, current]);

  // Lock-screen / headset play-pause controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action unsupported on this platform */
      }
    };
    set("play", () => void handleResume());
    set("pause", () => audioRef.current?.pause());
    return () => {
      set("play", null);
      set("pause", null);
    };
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

  // Rejoin the live stream after it was paused (e.g. another app took audio focus). Runs from a
  // click, so it satisfies the autoplay-gesture policy; hard-seeks to "now" first so we never
  // resume where it stopped.
  async function handleResume() {
    const audio = audioRef.current;
    if (!audio) return;
    startedRef.current = true;
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
          <span className={playing ? "live-dot" : "live-dot paused"} aria-hidden />
          <span className={playing ? "live-text" : "live-text paused"}>
            {current ? (playing ? "LIVE" : "PAUSED") : "waiting for the next song…"}
          </span>
          {current && !playing ? (
            <button className="player-btn" onClick={handleResume} aria-label="Play">
              <PlayGlyph />
            </button>
          ) : (
            <button
              className="player-btn"
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
              disabled={!current}
            >
              <NqIcon name={muted ? "volume-x" : "volume-2"} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline play triangle — the nimiq icon set has no play/pause glyph. Sizes/colors like NqIcon. */
function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden focusable="false">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
