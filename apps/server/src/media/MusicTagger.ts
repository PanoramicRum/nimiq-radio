import { spawn } from "node:child_process";

import type { FastifyBaseLogger } from "fastify";

import type { Config } from "../config";
import { songsTagged, taggerErrors } from "../metrics";

export interface TrackMeta {
  title: string;
  author?: string;
  album?: string;
  duration?: number;
  /** MusicBrainz release-group MBID of the chosen album, for Cover Art Archive lookup. */
  releaseGroupMbid?: string;
}

export interface MusicTagger {
  /**
   * Return corrected metadata when a confident AcoustID match exists; otherwise return
   * `fallback` unchanged. MUST NEVER THROW — fingerprinting is best-effort enrichment.
   */
  tag(audioPath: string, fallback: TrackMeta, opts?: { signal?: AbortSignal }): Promise<TrackMeta>;
}

/** Used when no ACOUSTID_API_KEY is configured: keep the yt-dlp metadata. */
export class NoopTagger implements MusicTagger {
  async tag(_audioPath: string, fallback: TrackMeta): Promise<TrackMeta> {
    return fallback;
  }
}

const ACOUSTID_URL = "https://api.acoustid.org/v2/lookup";
const USER_AGENT = "NimiqRadio/0.1 (https://github.com/nimiq)";

/** fpcalc (Chromaprint) -> AcoustID lookup -> corrected {title, artist, album}. */
export class AcoustIdTagger implements MusicTagger {
  constructor(
    private readonly cfg: Config,
    private readonly log: FastifyBaseLogger,
    private readonly apiKey: string,
  ) {}

  async tag(audioPath: string, fallback: TrackMeta, opts: { signal?: AbortSignal } = {}): Promise<TrackMeta> {
    try {
      const fp = await this.fpcalc(audioPath, opts.signal);
      if (!fp) return fallback;

      const recording = await this.lookup(fp.fingerprint, Math.round(fp.duration), opts.signal);
      if (!recording) return fallback;

      // Keep yt-dlp duration (authoritative for the playback timer); override the rest.
      const corrected: TrackMeta = {
        title: recording.title || fallback.title,
        author: recording.artist ?? fallback.author,
        album: recording.album ?? fallback.album,
        duration: fallback.duration,
        releaseGroupMbid: recording.releaseGroupMbid,
      };
      songsTagged.inc();
      this.log.info({ title: corrected.title, author: corrected.author, album: corrected.album }, "tagger: metadata corrected via AcoustID");
      return corrected;
    } catch (err) {
      taggerErrors.inc();
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "tagger: failed, keeping yt-dlp metadata");
      return fallback;
    }
  }

  /** Run `fpcalc -json -length 120 <file>` and parse {duration, fingerprint}. */
  private fpcalc(audioPath: string, signal?: AbortSignal): Promise<{ duration: number; fingerprint: string } | null> {
    return new Promise((resolve) => {
      const child = spawn(this.cfg.FPCALC_BIN, ["-json", "-length", "120", audioPath], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let settled = false;
      const done = (val: { duration: number; fingerprint: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(val);
      };
      const killGroup = () => {
        if (child.pid != null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      };
      const onAbort = () => {
        killGroup();
        done(null);
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        killGroup();
        done(null);
      }, this.cfg.FPCALC_TIMEOUT_MS);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.on("error", () => done(null));
      child.on("close", (code) => {
        if (code !== 0) return done(null);
        try {
          const j = JSON.parse(stdout) as { duration?: number; fingerprint?: string };
          if (typeof j.duration === "number" && typeof j.fingerprint === "string" && j.fingerprint.length > 0) {
            done({ duration: j.duration, fingerprint: j.fingerprint });
          } else {
            done(null);
          }
        } catch {
          done(null);
        }
      });
    });
  }

  /** Query AcoustID; return the best recording above the score threshold, or null. */
  private async lookup(
    fingerprint: string,
    durationSec: number,
    signal?: AbortSignal,
  ): Promise<{ title: string; artist?: string; album?: string; releaseGroupMbid?: string } | null> {
    const body = new URLSearchParams({
      client: this.apiKey,
      meta: "recordings releasegroups",
      duration: String(durationSec),
      fingerprint,
    });
    const res = await fetch(ACOUSTID_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body,
      signal: signal ?? AbortSignal.timeout(this.cfg.ACOUSTID_TIMEOUT_MS),
    });
    if (!res.ok) {
      this.log.warn({ status: res.status }, "tagger: AcoustID HTTP error");
      return null;
    }
    const data = (await res.json()) as AcoustIdResponse;
    if (data.status === "error") {
      // e.g. an invalid/account-instead-of-application key — make it visible, not silent.
      this.log.warn({ error: data.error?.message }, "tagger: AcoustID error (check ACOUSTID_API_KEY is an application key)");
      return null;
    }
    const results = Array.isArray(data.results) ? data.results : [];
    const best = results
      .filter((r) => (r.score ?? 0) >= this.cfg.ACOUSTID_MIN_SCORE && r.recordings?.some((rec) => rec.title))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    const recording = best?.recordings?.find((rec) => rec.title);
    if (!recording?.title) {
      this.log.debug({ results: results.length }, "tagger: no confident AcoustID match");
      return null;
    }

    const artist = recording.artists?.map((a) => a.name).filter(Boolean).join(", ") || undefined;
    const rg = pickReleaseGroup(recording.releasegroups);
    return { title: recording.title, artist, album: rg?.title, releaseGroupMbid: rg?.id };
  }
}

export function createMusicTagger(cfg: Config, log: FastifyBaseLogger): MusicTagger {
  if (cfg.ACOUSTID_API_KEY) {
    log.info("music tagger ENABLED (AcoustID fingerprint)");
    return new AcoustIdTagger(cfg, log, cfg.ACOUSTID_API_KEY);
  }
  log.info("music tagger DISABLED (set ACOUSTID_API_KEY to correct artist/album) — using yt-dlp metadata");
  return new NoopTagger();
}

/** Prefer a real studio album over compilations/singles. Returns the chosen group (title + MBID). */
function pickReleaseGroup(rgs?: ReleaseGroup[]): ReleaseGroup | undefined {
  if (!rgs || rgs.length === 0) return undefined;
  const isCompilation = (rg: ReleaseGroup) => rg.secondarytypes?.some((t) => t.toLowerCase() === "compilation");
  return (
    rgs.find((rg) => rg.type === "Album" && !isCompilation(rg)) ??
    rgs.find((rg) => rg.type === "Album") ??
    rgs[0]
  );
}

interface ReleaseGroup {
  /** Release-group MBID — returned by AcoustID with meta=releasegroups; maps to Cover Art Archive. */
  id?: string;
  type?: string;
  title?: string;
  secondarytypes?: string[];
}

interface AcoustIdResponse {
  status?: string;
  error?: { code?: number; message?: string };
  results?: Array<{
    score?: number;
    recordings?: Array<{
      title?: string;
      artists?: Array<{ name: string }>;
      releasegroups?: ReleaseGroup[];
    }>;
  }>;
}
