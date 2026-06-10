#!/usr/bin/env node
/**
 * Populate the radio's Creative-Commons (CC0) filler library.
 *
 * Reads the curated track list from apps/server/filler/manifest.json, resolves each `src`
 * basename against the archive.org item's file list, downloads the audio into the library dir,
 * and records ffprobe-measured durations in durations.json (the server prefers these for
 * accurate auto-advance). Idempotent: existing non-empty files are not re-downloaded.
 *
 * Run on the host (Node 18+):
 *   FILLER_DIR=/tmp/radio-tracks/library node deploy/fetch-filler.mjs
 * …or via the bundled docker one-shot (no host Node/ffmpeg needed — see DEPLOY.md):
 *   docker compose --profile init run --rm filler-fetch
 *
 * Env:
 *   FILLER_DIR        target audio dir            (default /tmp/radio-tracks/library)
 *   FILLER_MANIFEST   manifest path               (default <repo>/apps/server/filler/manifest.json)
 */
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const MANIFEST = process.env.FILLER_MANIFEST || path.join(repoRoot, "apps/server/filler/manifest.json");
const DIR = process.env.FILLER_DIR || "/tmp/radio-tracks/library";

const log = (...a) => console.log("[fetch-filler]", ...a);

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const item = manifest.source?.item || "freepd";
await mkdir(DIR, { recursive: true });

log(`resolving archive.org/metadata/${item} …`);
const metaRes = await fetch(`https://archive.org/metadata/${item}`);
if (!metaRes.ok) throw new Error(`archive.org metadata HTTP ${metaRes.status}`);
const meta = await metaRes.json();
const byBasename = new Map();
for (const f of meta.files ?? []) {
  const base = f.name.split("/").pop();
  if (!byBasename.has(base)) byBasename.set(base, f.name); // first match wins
}

const durations = {};
let downloaded = 0,
  present = 0,
  missing = 0,
  failed = 0;

for (const t of manifest.tracks) {
  const dest = path.join(DIR, t.file);
  const srcBase = t.src || t.file;

  // Already downloaded? keep it; just (re-)measure duration.
  try {
    const s = await stat(dest);
    if (s.size > 0) {
      durations[t.id] = probe(dest) ?? t.duration;
      present++;
      continue;
    }
  } catch {
    /* not present yet */
  }

  const iaName = byBasename.get(srcBase);
  if (!iaName) {
    log(`! "${srcBase}" not found in archive item — skipping ${t.id}`);
    missing++;
    continue;
  }
  const encoded = iaName.split("/").map(encodeURIComponent).join("/");
  const url = `https://archive.org/download/${item}/${encoded}`;
  try {
    log(`↓ ${t.id}  ←  ${iaName}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    durations[t.id] = probe(dest) ?? t.duration;
    downloaded++;
  } catch (err) {
    log(`✗ ${t.id}: ${err.message}`);
    failed++;
  }
}

await writeFile(path.join(DIR, "durations.json"), `${JSON.stringify(durations, null, 2)}\n`);
log(`done — ${downloaded} downloaded, ${present} already present, ${missing} not in archive, ${failed} failed`);
log(`library: ${DIR}`);
if (missing + failed > 0) process.exitCode = 1;

/** ffprobe a file's duration in whole seconds, or undefined if ffprobe is unavailable/fails. */
function probe(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return undefined;
  const d = Math.round(Number.parseFloat((r.stdout || "").trim()));
  return Number.isFinite(d) && d > 0 ? d : undefined;
}
