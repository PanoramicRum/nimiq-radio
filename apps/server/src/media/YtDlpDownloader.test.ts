import { describe, expect, it } from "vitest";

import { friendlyDownloadError } from "./YtDlpDownloader";

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
    const msg = friendlyDownloadError("ERROR: some obscure extractor failure with a stack trace");
    expect(msg).toBe("Couldn't fetch that video — it may be unavailable, private, or region-restricted. Try a different link.");
    expect(msg).not.toMatch(/stack trace/);
  });
});
