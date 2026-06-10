import { z } from "zod";

import { isAudioFilename } from "../fs/trackStore";

/**
 * Schema for the committed filler manifest (apps/server/filler/manifest.json). The manifest is
 * server-owned data, never client-supplied, so it lives here rather than in @radio/shared.
 *
 * `duration` is REQUIRED and must be > 0: the auto-advance timer keys off it, and a filler with
 * no duration would play once and never advance — a permanent stall, worse than going idle.
 */
export const FillerTrackSchema = z.object({
  /** Stable kebab-case id; also the served filename stem. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  /** Local served filename inside the library dir, e.g. "lib-ambient-zyow.mp3". */
  file: z.string().min(1).refine(isAudioFilename, "file must end in a known audio extension"),
  /** Source filename in the upstream archive.org item (matched by basename). Defaults to `file`. */
  src: z.string().min(1).optional(),
  title: z.string().min(1),
  author: z.string().min(1).default("FreePD (CC0)"),
  genre: z.string().min(1),
  /** Best-effort seconds (> 0). deploy/fetch-filler.sh measures the real value via ffprobe. */
  duration: z.number().positive(),
});
export type FillerTrack = z.infer<typeof FillerTrackSchema>;

/**
 * Loose envelope around the track list. The loader validates each track individually with
 * {@link FillerTrackSchema} so one bad entry (e.g. a zero duration) is dropped with a warning
 * rather than disabling the whole library.
 */
export const FillerManifestEnvelopeSchema = z.object({
  source: z
    .object({
      type: z.string(),
      item: z.string().optional(),
      license: z.string(),
    })
    .passthrough()
    .optional(),
  /** Genre ring for the slow-drift walk; genres present in tracks but absent here are appended. */
  genreOrder: z.array(z.string()).optional(),
  tracks: z.array(z.unknown()).default([]),
});
export type FillerManifestEnvelope = z.infer<typeof FillerManifestEnvelopeSchema>;
