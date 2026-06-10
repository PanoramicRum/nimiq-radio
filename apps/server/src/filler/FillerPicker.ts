export interface PickerTrack {
  id: string;
  genre: string;
}

export interface FillerPickerOptions {
  /** RNG in [0,1). Injectable so tests are deterministic (no global Math.random patching). */
  rng?: () => number;
  /** Probability of staying in the current genre each pick; otherwise drift one step. */
  stayProbability?: number;
  /** How many recently-played ids to avoid repeating. */
  recentWindow?: number;
}

const DEFAULT_STAY_PROBABILITY = 0.7;
const DEFAULT_RECENT_WINDOW = 5;

/**
 * Pure genre-walk selector for the radio filler: "usually the same genre, with slow drift."
 *
 * Each pick stays in the current genre with `stayProbability`; otherwise it steps ±1 along a
 * genre ring (a weighted random walk → adjacent genres, gentle transitions). Within the chosen
 * genre it picks uniformly at random, avoiding the last `recentWindow` track ids.
 *
 * No IO and no clock — fully deterministic given an injected `rng`, so it is directly testable.
 * Each pickNext() consumes `rng()` up to 3 times in order: (1) stay-vs-drift, (2) drift
 * direction (only when drifting), (3) candidate index.
 */
export class FillerPicker {
  private readonly byGenre = new Map<string, PickerTrack[]>();
  private readonly ring: string[];
  private readonly rng: () => number;
  private readonly stayProbability: number;
  private readonly recentWindow: number;
  private readonly recent: string[] = [];
  private genreIndex = 0;

  constructor(tracks: PickerTrack[], genreOrder: string[] = [], opts: FillerPickerOptions = {}) {
    for (const t of tracks) {
      const list = this.byGenre.get(t.genre);
      if (list) list.push(t);
      else this.byGenre.set(t.genre, [t]);
    }
    // Ring = requested order (limited to genres we actually have), then any remaining genres sorted.
    const present = new Set(this.byGenre.keys());
    const ordered = genreOrder.filter((g) => present.has(g));
    const remaining = [...present].filter((g) => !ordered.includes(g)).sort();
    this.ring = [...ordered, ...remaining];

    this.rng = opts.rng ?? Math.random;
    this.stayProbability = opts.stayProbability ?? DEFAULT_STAY_PROBABILITY;
    // Cap the window so a small library always keeps at least one fresh candidate.
    this.recentWindow = Math.max(0, Math.min(opts.recentWindow ?? DEFAULT_RECENT_WINDOW, tracks.length - 1));
  }

  /** The genre ring, in walk order (mostly for tests / logging). */
  get genres(): string[] {
    return [...this.ring];
  }

  /** Pick the next filler track, or null if the library is empty. */
  pickNext(): PickerTrack | null {
    if (this.ring.length === 0) return null;

    // 1) Stay in the current genre, or drift one step along the ring.
    if (this.ring.length > 1 && this.rng() >= this.stayProbability) {
      const step = this.rng() < 0.5 ? -1 : 1;
      this.genreIndex = (this.genreIndex + step + this.ring.length) % this.ring.length;
    }
    const genre = this.ring[this.genreIndex];

    // 2) Candidates: this genre minus recents, with graceful fallbacks so we never return null
    //    while the library is non-empty.
    const inGenre = this.byGenre.get(genre) ?? [];
    let candidates = inGenre.filter((t) => !this.recent.includes(t.id));
    if (candidates.length === 0) candidates = inGenre;
    if (candidates.length === 0) {
      const all = [...this.byGenre.values()].flat();
      candidates = all.filter((t) => !this.recent.includes(t.id));
      if (candidates.length === 0) candidates = all;
    }
    if (candidates.length === 0) return null;

    // 3) Uniform pick.
    const chosen = candidates[Math.floor(this.rng() * candidates.length)];

    // 4) Remember it (bounded ring of recent ids).
    this.recent.push(chosen.id);
    while (this.recent.length > this.recentWindow) this.recent.shift();

    return chosen;
  }
}
