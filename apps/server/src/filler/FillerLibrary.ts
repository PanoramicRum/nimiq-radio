import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyBaseLogger } from "fastify";

import { FillerPicker } from "./FillerPicker";
import type { FillerDescriptor, FillerSource } from "./FillerSource";
import { FillerManifestEnvelopeSchema, FillerTrackSchema } from "./manifest";

/** Default manifest location: apps/server/filler/manifest.json (two dirs up from src/filler/). */
const DEFAULT_MANIFEST_PATH = fileURLToPath(new URL("../../filler/manifest.json", import.meta.url));

export interface FillerLibraryOptions {
  /** Directory holding the downloaded audio files (e.g. <TRACKS_DIR>/library). */
  dir: string;
  /** Path to the committed manifest JSON. Null/undefined → the built-in default. */
  manifestPath?: string | null;
  /** Public URL prefix the audio is served under (the /static/library mount). */
  urlPrefix?: string;
  log: FastifyBaseLogger;
  /** Injectable RNG for the picker (tests). */
  rng?: () => number;
}

/**
 * Loads the curated CC0 filler manifest and turns it into a {@link FillerSource} the engine can
 * pull from. It NEVER throws: a missing/invalid manifest, or missing audio, yields an empty
 * library and the engine falls back to its original idle behavior.
 *
 * Two invariants are enforced here:
 *  - every served track has a positive duration (the manifest schema requires it; we also honor a
 *    fetch-time `durations.json` override measured by ffprobe for accurate playback);
 *  - a track is only kept if its audio file actually exists on disk (drop + warn otherwise).
 */
export class FillerLibrary implements FillerSource {
  private constructor(
    private readonly tracks: FillerDescriptor[],
    private readonly picker: FillerPicker,
  ) {}

  static async load(opts: FillerLibraryOptions): Promise<FillerLibrary> {
    const { dir, log } = opts;
    const urlPrefix = opts.urlPrefix ?? "/static/library/";
    const manifestPath = opts.manifestPath || DEFAULT_MANIFEST_PATH;
    const empty = () => new FillerLibrary([], new FillerPicker([], []));

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      log.warn({ manifestPath }, "filler: no manifest — radio filler disabled (graceful idle)");
      return empty();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.error({ err, manifestPath }, "filler: manifest is not valid JSON — filler disabled");
      return empty();
    }

    const envelope = FillerManifestEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      log.error({ issues: envelope.error.issues, manifestPath }, "filler: manifest failed validation — filler disabled");
      return empty();
    }
    const { genreOrder, tracks: rawTracks } = envelope.data;

    // Optional ffprobe-measured durations (id -> seconds), written by deploy/fetch-filler.mjs, so
    // runtime playback is accurate without any runtime ffprobe.
    const measured = await loadMeasuredDurations(path.join(dir, "durations.json"));

    const descriptors: FillerDescriptor[] = [];
    for (const raw of rawTracks) {
      // Validate per entry so one bad track (e.g. a zero/negative duration → would stall the
      // radio) is dropped rather than disabling the whole library.
      const parsedTrack = FillerTrackSchema.safeParse(raw);
      if (!parsedTrack.success) {
        log.warn({ issues: parsedTrack.error.issues }, "filler: invalid manifest entry — skipping");
        continue;
      }
      const t = parsedTrack.data;
      const filePath = path.join(dir, t.file);
      try {
        await access(filePath);
      } catch {
        log.warn({ id: t.id, file: t.file, dir }, "filler: audio missing — skipping (run deploy/fetch-filler.mjs)");
        continue;
      }
      const override = measured[t.id];
      const duration = typeof override === "number" && override > 0 ? override : t.duration;
      descriptors.push({
        id: t.id,
        trackUrl: `${urlPrefix}${encodeURIComponent(t.file)}`,
        title: t.title,
        author: t.author,
        duration,
        genre: t.genre,
      });
    }

    if (descriptors.length === 0) {
      log.warn({ manifestPath, dir }, "filler: 0 playable tracks (no audio downloaded?) — graceful idle");
    } else {
      log.info(
        { count: descriptors.length, genres: [...new Set(descriptors.map((d) => d.genre))] },
        "filler: library loaded",
      );
    }

    const picker = new FillerPicker(
      descriptors.map((d) => ({ id: d.id, genre: d.genre })),
      genreOrder ?? [],
      { rng: opts.rng },
    );
    return new FillerLibrary(descriptors, picker);
  }

  isEmpty(): boolean {
    return this.tracks.length === 0;
  }

  next(): FillerDescriptor | null {
    const pick = this.picker.pickNext();
    if (!pick) return null;
    return this.tracks.find((t) => t.id === pick.id) ?? null;
  }
}

/** Best-effort read of the ffprobe-measured durations sidecar. Absent/garbage → {} (no override). */
async function loadMeasuredDurations(p: string): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(p, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as Record<string, number>;
  } catch {
    /* none yet — fall back to manifest durations */
  }
  return {};
}
