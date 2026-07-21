import { describe, expect, it } from "vitest";

import { classifyDownloadError, friendlyDownloadError } from "./YtDlpDownloader";

describe("friendlyDownloadError", () => {
  it("collapses YouTube's giant geo-block message to one line", () => {
    const geo =
      "ERROR: [youtube] PZYSiWHW8V0: The uploader has not made this video available in your country " +
      "This video is available in Andorra, United Arab Emirates, Afghanistan, Antigua and Barbuda, …";
    expect(friendlyDownloadError(geo)).toBe("This video isn't available in the radio's region.");
  });

  it("maps the common failure modes", () => {
    expect(friendlyDownloadError("ERROR: Private video. Sign in if you've been granted access")).toMatch(/private/i);
    expect(friendlyDownloadError("ERROR: Video unavailable. This video has been removed")).toMatch(/unavailable|removed/i);
    expect(friendlyDownloadError("ERROR: Sign in to confirm your age")).toMatch(/age-restricted/i);
    expect(friendlyDownloadError("ERROR: Sign in to confirm you're not a bot")).toMatch(/verifying/i);
    expect(friendlyDownloadError("ERROR: Join this channel to get access to members-only content")).toMatch(/members-only/i);
  });

  it("never leaks the raw stderr — unknown errors get a generic line", () => {
    const msg = friendlyDownloadError("ERROR: some obscure failure with a stack trace");
    expect(msg).toBe("Couldn't fetch that video — it may be unavailable, private, or region-restricted. Try a different link.");
    expect(msg).not.toMatch(/stack trace/);
  });
});

describe("classifyDownloadError", () => {
  it("flags extractor breakage (stale yt-dlp) as operator-actionable, not a bad link", () => {
    const cases = [
      "ERROR: [youtube] dQw4w9WgXcQ: Failed to extract any player response; please report this issue",
      "ERROR: [youtube] dQw4w9WgXcQ: Requested format is not available. Use --list-formats for a list of available formats",
      "ERROR: [youtube] dQw4w9WgXcQ: nsig extraction failed: Some formats may be missing",
      "ERROR: [youtube] dQw4w9WgXcQ: Unable to extract yt initial data",
      "ERROR: [youtube] dQw4w9WgXcQ: No video formats found!; please report this issue",
      "ERROR: [youtube] dQw4w9WgXcQ: Fetching PO token failed",
    ];
    for (const stderr of cases) {
      const { kind, message } = classifyDownloadError(stderr);
      expect(kind, stderr).toBe("extractor_stale");
      expect(message).toMatch(/downloader needs an update/i);
      expect(message).not.toMatch(/your link is bad|unavailable, private/i);
    }
  });

  it("video-level reasons still win over the broad extractor needles (ordering guard)", () => {
    // These stderr lines ALSO contain broad needles like "unable to extract"/"sign in",
    // but must keep mapping to their specific video-level reason.
    expect(classifyDownloadError("ERROR: [youtube] abc: Private video. Sign in if you've been granted access. Unable to extract video data").kind).toBe(
      "private",
    );
    expect(classifyDownloadError("ERROR: [youtube] abc: Video unavailable. This video has been removed. Failed to extract player response").kind).toBe(
      "removed",
    );
    expect(classifyDownloadError("ERROR: [youtube] abc: Sign in to confirm you're not a bot").kind).toBe("bot_check");
    expect(
      classifyDownloadError("ERROR: [youtube] abc: The uploader has not made this video available in your country").kind,
    ).toBe("geo_blocked");
  });

  it("treats the deprecated-client symptom 'not available on this app' as stale, not removed", () => {
    const stderr =
      "ERROR: [youtube] abc12345678: The following content is not available on this app. Watch this content on the latest version of YouTube";
    expect(classifyDownloadError(stderr).kind).toBe("extractor_stale");
  });

  it("does not blame YouTube when another source's extractor breaks", () => {
    const { kind, message } = classifyDownloadError("ERROR: [Bandcamp] xyz: Unable to extract embedded player data");
    expect(kind).toBe("extractor_stale");
    expect(message).not.toMatch(/YouTube/);
    expect(message).toMatch(/downloader needs an update/i);
    // The YouTube variant still names the working alternatives:
    const yt = classifyDownloadError("ERROR: [youtube] abc: Unable to extract yt initial data");
    expect(yt.message).toMatch(/YouTube changed something/);
    expect(yt.message).toMatch(/SoundCloud, Bandcamp and Audius/);
  });

  it("flags YouTube 403s as server-side blocking (datacenter-IP bot flag), not a bad link", () => {
    const cases = [
      "ERROR: unable to download video data: HTTP Error 403: Forbidden",
      "ERROR: [youtube] dQw4w9WgXcQ: HTTP Error 403: Forbidden",
      "ERROR: fragment 1 not found, unable to continue: HTTP Error 403: Forbidden",
    ];
    for (const stderr of cases) {
      const { kind, message } = classifyDownloadError(stderr);
      expect(kind, stderr).toBe("blocked_403");
      expect(message).toMatch(/isn't a problem with your link/i);
    }
  });

  it("keeps the generic fallback for genuinely unknown errors", () => {
    const { kind, message } = classifyDownloadError("ERROR: something entirely new and weird");
    expect(kind).toBe("unknown");
    expect(message).toMatch(/Couldn't fetch that video/);
  });
});
