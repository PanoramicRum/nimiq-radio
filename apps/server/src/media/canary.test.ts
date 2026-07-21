import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";

import type { Config } from "../config";
import { startYtCanary } from "./canary";
import { DownloadError } from "./Downloader";

const makeLog = () =>
  ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }) as unknown as FastifyBaseLogger;

const makeCfg = (over: Partial<Config> = {}): Config =>
  ({
    YT_CANARY_INTERVAL_MS: 21_600_000,
    YT_CANARY_URL: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    ...over,
  }) as Config;

describe("startYtCanary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is disabled when the interval is 0 (state() returns null, probe never called)", () => {
    const probe = vi.fn();
    const canary = startYtCanary(makeCfg({ YT_CANARY_INTERVAL_MS: 0 }), makeLog(), probe);
    expect(canary.state()).toBeNull();
    vi.advanceTimersByTime(100 * 21_600_000);
    expect(probe).not.toHaveBeenCalled();
    canary.stop();
  });

  it("disables itself (with an error log) on an invalid YT_CANARY_URL", () => {
    const log = makeLog();
    const canary = startYtCanary(makeCfg({ YT_CANARY_URL: "not a url" }), log, vi.fn());
    expect(canary.state()).toBeNull();
    expect(log.error).toHaveBeenCalledOnce();
    canary.stop();
  });

  it("probes the canonicalized URL after the boot delay and records success", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const canary = startYtCanary(makeCfg({ YT_CANARY_URL: "https://youtu.be/jNQXAC9IVRw" }), makeLog(), probe);

    expect(canary.state()).toEqual({ ok: null });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(probe).toHaveBeenCalledWith("https://www.youtube.com/watch?v=jNQXAC9IVRw");
    expect(canary.state()).toMatchObject({ ok: true });
    expect(canary.state()?.lastCheck).toBeTruthy();
    expect(canary.state()?.lastError).toBeUndefined();
    canary.stop();
  });

  it("records failure with the DownloadError kind and logs the stable marker", async () => {
    const probe = vi.fn().mockRejectedValue(new DownloadError("YouTube changed something…", "extractor_stale"));
    const log = makeLog();
    const canary = startYtCanary(makeCfg(), log, probe);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(canary.state()).toMatchObject({ ok: false, lastError: expect.stringContaining("extractor_stale") });
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("YOUTUBE CANARY FAILING"));
    canary.stop();
  });

  it("keeps probing on the interval and recovers to ok after a failure", async () => {
    const probe = vi.fn().mockRejectedValueOnce(new DownloadError("boom", "extractor_stale")).mockResolvedValue(undefined);
    const canary = startYtCanary(makeCfg(), makeLog(), probe);

    await vi.advanceTimersByTimeAsync(60_000); // boot probe → fail
    expect(canary.state()).toMatchObject({ ok: false });

    await vi.advanceTimersByTimeAsync(21_600_000); // first interval probe → recover
    expect(probe).toHaveBeenCalledTimes(2);
    expect(canary.state()).toMatchObject({ ok: true });
    expect(canary.state()?.lastError).toBeUndefined();
    canary.stop();
  });

  it("stop() halts all future probes", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const canary = startYtCanary(makeCfg(), makeLog(), probe);
    canary.stop();
    await vi.advanceTimersByTimeAsync(10 * 21_600_000);
    expect(probe).not.toHaveBeenCalled();
  });
});
