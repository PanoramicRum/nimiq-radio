import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FillerLibrary } from "./FillerLibrary";

// Minimal logger stub — the loader only calls info/warn/error.
const log = { info() {}, warn() {}, error() {} } as never;

let dir = "";
const manifestPath = () => path.join(dir, "manifest.json");

async function writeManifest(obj: unknown): Promise<void> {
  await writeFile(manifestPath(), JSON.stringify(obj));
}
async function touch(file: string): Promise<void> {
  await writeFile(path.join(dir, file), "x"); // a non-empty placeholder; loader only checks existence
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "filler-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function load(rng: () => number = () => 0) {
  return FillerLibrary.load({ dir, manifestPath: manifestPath(), log, rng });
}

async function collectIds(lib: FillerLibrary, n = 12): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let i = 0; i < n; i++) {
    const d = lib.next();
    if (d) ids.add(d.id);
  }
  return ids;
}

describe("FillerLibrary.load", () => {
  it("loads valid tracks and applies the ffprobe duration override", async () => {
    await writeManifest({
      genreOrder: ["a"],
      tracks: [{ id: "lib-x", file: "x.mp3", title: "X", genre: "a", duration: 100 }],
    });
    await touch("x.mp3");
    await writeFile(path.join(dir, "durations.json"), JSON.stringify({ "lib-x": 250 }));

    const lib = await load();
    expect(lib.isEmpty()).toBe(false);
    const d = lib.next();
    expect(d?.id).toBe("lib-x");
    expect(d?.trackUrl).toBe("/static/library/x.mp3");
    expect(d?.duration).toBe(250); // override wins over the manifest's 100
    expect(d?.author).toBe("FreePD (CC0)"); // schema default
  });

  it("drops a track whose audio file is missing", async () => {
    await writeManifest({
      tracks: [
        { id: "lib-a", file: "a.mp3", title: "A", genre: "a", duration: 120 },
        { id: "lib-b", file: "b.mp3", title: "B", genre: "a", duration: 120 },
      ],
    });
    await touch("a.mp3"); // b.mp3 intentionally absent

    const ids = await collectIds(await load());
    expect(ids).toEqual(new Set(["lib-a"]));
  });

  it("drops a zero-duration entry but keeps valid ones (no radio stall)", async () => {
    await writeManifest({
      tracks: [
        { id: "lib-bad", file: "bad.mp3", title: "Bad", genre: "a", duration: 0 },
        { id: "lib-good", file: "good.mp3", title: "Good", genre: "a", duration: 90 },
      ],
    });
    await touch("bad.mp3");
    await touch("good.mp3");

    const ids = await collectIds(await load());
    expect(ids).toEqual(new Set(["lib-good"]));
  });

  it("returns an empty library when the manifest is missing", async () => {
    const lib = await FillerLibrary.load({ dir, manifestPath: path.join(dir, "nope.json"), log });
    expect(lib.isEmpty()).toBe(true);
    expect(lib.next()).toBeNull();
  });
});
