import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";

import type { Config } from "../config";
import { DownloadError, type DownloadResult, type Downloader, type ProbeInfo } from "./Downloader";

/**
 * Downloads + transcodes audio to MP3 via the yt-dlp binary (which drives ffmpeg).
 *
 * Robustness (plan, Phase 1):
 *  - spawned with an argument array, never a shell string,
 *  - opaque random output id (not the YouTube id) to avoid enumeration/hotlinking,
 *  - detached process group so a wall-clock timeout SIGKILLs runaway ffmpeg children too,
 *  - duration/filesize/livestream caps enforced by yt-dlp flags,
 *  - datacenter-IP hardening: PO-token sidecar + player-client + optional cookies.
 */
export class YtDlpDownloader implements Downloader {
  constructor(
    private readonly cfg: Config,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Metadata-only probe (no media downloaded) for the content gate. */
  async probe(canonicalUrl: string, opts: { signal?: AbortSignal } = {}): Promise<ProbeInfo> {
    const args = [canonicalUrl, "--dump-json", "--skip-download", ...this.buildBaseArgs()];
    this.log.debug({ canonicalUrl }, "yt-dlp probe");
    const { stdout } = await this.run(args, opts.signal);
    const info = parseProbe(stdout);

    // Persist the raw info-dict so download() can reuse this extraction via --load-info-json
    // (one YouTube round-trip instead of two). Best-effort; the caller deletes the file.
    const jsonLine = stdout
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    if (jsonLine) {
      try {
        const p = path.join(os.tmpdir(), `ytinfo-${randomBytes(8).toString("hex")}.info.json`);
        await writeFile(p, jsonLine);
        info.infoJsonPath = p;
      } catch {
        /* download() will fall back to a fresh extraction */
      }
    }
    return info;
  }

  async download(canonicalUrl: string, opts: { signal?: AbortSignal; infoJsonPath?: string } = {}): Promise<DownloadResult> {
    const id = randomBytes(16).toString("hex");
    const outputTemplate = path.join(this.cfg.TRACKS_DIR, `${id}.%(ext)s`);
    const finalPath = path.join(this.cfg.TRACKS_DIR, `${id}.${this.cfg.AUDIO_FORMAT}`);

    // Prefer reusing the content gate's extraction (--load-info-json) so we hit YouTube once.
    // If that produces no file (edge cases in loaded info), re-extract from the URL.
    let stdout = "";
    if (opts.infoJsonPath) {
      this.log.debug({ id }, "yt-dlp start (reusing probe info-json)");
      try {
        ({ stdout } = await this.run(this.buildArgs(["--load-info-json", opts.infoJsonPath], outputTemplate), opts.signal));
      } catch (err) {
        this.log.warn({ id, err: err instanceof Error ? err.message : String(err) }, "yt-dlp: --load-info-json failed, re-extracting");
      }
      if (!existsSync(finalPath)) {
        ({ stdout } = await this.run(this.buildArgs([canonicalUrl], outputTemplate), opts.signal));
      }
    } else {
      this.log.debug({ id, canonicalUrl }, "yt-dlp start");
      ({ stdout } = await this.run(this.buildArgs([canonicalUrl], outputTemplate), opts.signal));
    }

    if (!existsSync(finalPath)) {
      // yt-dlp exits 0 when a --match-filter rejects the video (livestream / too long),
      // producing no file. Treat that as a clean failure, not a crash.
      throw new DownloadError(
        "No audio file was produced. The video may be a livestream, exceed the duration/size limit, or be unavailable.",
      );
    }

    const meta = parseMetadata(stdout);
    this.log.info({ id, title: meta.title, duration: meta.duration }, "yt-dlp ready");
    return {
      id,
      trackPath: finalPath,
      title: meta.title ?? "Unknown title",
      author: meta.author,
      album: meta.album,
      duration: meta.duration,
      thumbnail: meta.thumbnail,
    };
  }

  /** `input` is either [url] for a fresh extraction or ["--load-info-json", path] to reuse one. */
  private buildArgs(input: string[], outputTemplate: string): string[] {
    const fmt = this.cfg.AUDIO_FORMAT;
    const args = [
      ...input,
      // Prefer YouTube's audio-only stream in the target container (copied, not re-encoded);
      // fall back to bestaudio (re-encoded to the target format) only when none exists.
      "-f",
      `bestaudio[ext=${fmt}]/bestaudio`,
      "-x",
      "--audio-format",
      fmt,
      "--audio-quality",
      this.cfg.AUDIO_BITRATE,
      "--match-filter",
      `!is_live & duration < ${this.cfg.MAX_DURATION_SEC}`,
      "--max-filesize",
      this.cfg.MAX_FILESIZE,
      "--no-progress",
      "--print-json",
      "-o",
      outputTemplate,
      ...this.buildBaseArgs(),
    ];
    // For MP4/m4a, write the moov atom at the front (faststart). Every listener joins mid-song and
    // seeks to the live position; with moov-at-end the browser must first fetch the file tail,
    // stalling the start. faststart lets the seek begin immediately.
    if (fmt === "m4a" || fmt === "mp4") {
      args.push("--postprocessor-args", "ExtractAudio:-movflags +faststart");
    }
    return args;
  }

  /** Args shared by probe + download so YouTube sees the same client for both. */
  private buildBaseArgs(): string[] {
    const args = ["--no-playlist", "--socket-timeout", "30", "--no-warnings"];
    // Avoid GVS PO-token requirements where possible.
    if (this.cfg.PLAYER_CLIENT) {
      args.push("--extractor-args", `youtube:player_client=${this.cfg.PLAYER_CLIENT}`);
    }
    // bgutil PO-token provider sidecar (datacenter IPs).
    if (this.cfg.PO_TOKEN_BASE_URL) {
      args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${this.cfg.PO_TOKEN_BASE_URL}`);
    }
    // Cookies from a throwaway account — only if the file holds real entries
    // (a comment-only placeholder is treated as "no cookies").
    const cookies = this.writableCookiesPath();
    if (cookies) {
      args.push("--cookies", cookies);
    }
    return args;
  }

  /**
   * yt-dlp rewrites the cookie jar back to the --cookies path after every YouTube session, so the
   * file must be writable — but the configured COOKIES_FILE is a read-only bind mount (passing it
   * directly fails with EROFS). We stage a writable copy in TRACKS_DIR (created by the app user, so
   * it owns it) and let yt-dlp rewrite that, re-copying whenever the source is updated (a fresh
   * upload has a newer mtime). Returns the path to pass to --cookies, or null when no real cookies
   * are configured. The copy lives as a dotfile so it's neither served nor swept by cleanup.
   */
  private writableCookiesPath(): string | null {
    const src = this.cfg.COOKIES_FILE;
    if (!src || !hasCookieData(src)) return null;
    const dst = path.join(this.cfg.TRACKS_DIR, ".yt-cookies.txt");
    try {
      const fresh = existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs;
      if (!fresh) {
        copyFileSync(src, dst);
        chmodSync(dst, 0o600);
      }
      return dst;
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "cookies: could not stage a writable copy");
      return existsSync(dst) ? dst : null;
    }
  }

  private run(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.YTDLP_BIN, args, {
        detached: true, // own process group so we can SIGKILL the whole subtree
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid != null) {
          try {
            process.kill(-child.pid, sig);
          } catch {
            /* group already gone */
          }
        }
      };

      const onAbort = () => killGroup("SIGKILL");
      if (signal) {
        if (signal.aborted) killGroup("SIGKILL");
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGKILL");
      }, this.cfg.DOWNLOAD_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new DownloadError(`Failed to start yt-dlp: ${err.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (timedOut) {
          reject(new DownloadError(`Download timed out after ${this.cfg.DOWNLOAD_TIMEOUT_MS}ms.`));
          return;
        }
        if (signal?.aborted) {
          reject(new DownloadError("Download aborted."));
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        // Keep the full reason (e.g. YouTube's giant geo-block country list) in the server log;
        // hand the user one short, friendly line.
        this.log.warn({ code, stderr: stderr.trim().split("\n").slice(-5).join("\n") }, "yt-dlp failed");
        reject(new DownloadError(friendlyDownloadError(stderr)));
      });
    });
  }
}

/**
 * Map raw yt-dlp stderr to a short, user-facing reason. yt-dlp dumps verbose detail (a geo-block
 * lists every allowed country, etc.) that we never want to show a listener — the full text stays in
 * the server log. Ordered most-specific first; falls back to a generic line.
 */
export function friendlyDownloadError(stderr: string): string {
  const s = stderr.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((n) => s.includes(n));

  if (has("available in your country", "in your country", "blocked it in your", "not available in your location")) {
    return "This video isn't available in the radio's region.";
  }
  if (has("confirm your age", "age-restricted", "inappropriate for some users")) {
    return "This video is age-restricted, so it can't be added.";
  }
  if (has("members-only", "join this channel", "available to this channel")) {
    return "This is a members-only video.";
  }
  if (has("private video")) {
    return "This video is private.";
  }
  if (has("premiere", "this live event", "is upcoming")) {
    return "This video hasn't premiered yet.";
  }
  if (has("copyright")) {
    return "This video is blocked on copyright grounds.";
  }
  if (has("video unavailable", "has been removed", "no longer available", "been terminated", "is not available", "removed by the uploader")) {
    return "This video is unavailable or has been removed.";
  }
  if (has("confirm you", "sign in to confirm", "not a bot")) {
    return "YouTube is verifying the server right now — please try again in a moment.";
  }
  if (has("sign in", "log in", "login required")) {
    return "This video requires sign-in and can't be added.";
  }
  return "Couldn't fetch that video — it may be unavailable, private, or region-restricted. Try a different link.";
}

/** True only if the cookies file has at least one non-comment, non-blank line. */
function hasCookieData(p: string): boolean {
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .some((line) => {
        const t = line.trim();
        return t.length > 0 && !t.startsWith("#");
      });
  } catch {
    return false;
  }
}

interface Metadata {
  title?: string;
  author?: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
}

/** Parse the info-dict JSON (from --dump-json) into the content-gate's ProbeInfo. */
function parseProbe(stdout: string): ProbeInfo {
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!line) return {};
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const categories = Array.isArray(j.categories) ? (j.categories.filter((c) => typeof c === "string") as string[]) : undefined;
    return {
      duration: num(j.duration),
      isLive: j.is_live === true,
      categories,
      title: str(j.title),
      track: str(j.track),
      artist: str(j.artist),
      album: str(j.album),
      uploader: str(j.uploader) ?? str(j.channel),
    };
  } catch {
    return {};
  }
}

/** yt-dlp --print-json emits one info-dict JSON line. Find and map the fields we need. */
function parseMetadata(stdout: string): Metadata {
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!line) return {};
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return {
      // YouTube Music exposes track/artist/album; regular videos fall back to title/uploader.
      title: str(j.track) ?? str(j.title),
      author: str(j.artist) ?? str(j.uploader) ?? str(j.channel),
      album: str(j.album),
      duration: num(j.duration),
      thumbnail: str(j.thumbnail),
    };
  } catch {
    return {};
  }
}
