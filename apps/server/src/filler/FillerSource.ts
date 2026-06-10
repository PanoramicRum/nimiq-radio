/**
 * The engine's view of the radio filler library. Kept as a tiny interface (no file IO) so the
 * RadioEngine stays pure and unit-testable: tests inject a stub FillerSource, production injects
 * the real FillerLibrary.
 */

/** A ready-to-play, server-owned Creative-Commons filler track. */
export interface FillerDescriptor {
  /** Stable id (e.g. "lib-ambient-zyow") — same across restarts so recent-repeat tracking works. */
  id: string;
  /** Public path under the /static/library mount, e.g. "/static/library/lib-ambient-zyow.mp3". */
  trackUrl: string;
  title: string;
  author: string;
  /** Seconds, always > 0 (a duration-less filler would never auto-advance — the radio would stall). */
  duration: number;
  genre: string;
}

export interface FillerSource {
  /** True when there is nothing to play (no manifest / no audio downloaded yet). */
  isEmpty(): boolean;
  /** The next filler track to play, or null when the library is empty. */
  next(): FillerDescriptor | null;
}
