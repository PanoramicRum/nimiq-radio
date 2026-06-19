import type { QueueItem, RadioState } from "@radio/shared";
import { describe, expect, it } from "vitest";

import { elapsedSeconds, escapeHtml, formatDuration, formatPaid, lunaToNim, shortAddress } from "./format";

function stateWith(current: QueueItem | null, startedAtServerMs: number | null, serverNowMs: number): RadioState {
  return { current, startedAtServerMs, queue: [], paused: false, seq: 1, listeners: 0, serverNowMs };
}
function song(over: Partial<QueueItem> = {}): QueueItem {
  return { id: "u1", sourceUrl: "https://x", trackUrl: "/t.m4a", title: "Song", amountPaid: 0, createdAt: "2026-01-01T00:00:00Z", status: "playing", ...over };
}

describe("formatDuration", () => {
  it("formats m:ss with zero padding", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3661)).toBe("61:01");
  });
});

describe("lunaToNim / formatPaid", () => {
  it("converts luna to NIM and labels free vs paid", () => {
    expect(lunaToNim(100_000)).toBe("1");
    expect(formatPaid(0)).toBe("free");
    expect(formatPaid(100_000)).toContain("NIM");
  });
});

describe("shortAddress", () => {
  it("compacts long addresses and leaves short ones alone", () => {
    expect(shortAddress("NQ12 ABCD EFGH IJKL MNOP QRST UVWX YZ12")).toContain("…");
    expect(shortAddress("NQ12")).toBe("NQ12");
  });
});

describe("elapsedSeconds", () => {
  it("computes skew-free elapsed via the server clock, clamped to [0, duration]", () => {
    expect(elapsedSeconds(stateWith(song({ duration: 200 }), 1000, 51_000))).toBe(50);
    expect(elapsedSeconds(stateWith(song({ duration: 200 }), 1000, 9_999_999))).toBe(200); // clamp high
    expect(elapsedSeconds(stateWith(song({ duration: 200 }), 5000, 1000))).toBe(0); // clamp low
    expect(elapsedSeconds(stateWith(null, null, 1000))).toBe(0); // idle
  });
});

describe("escapeHtml", () => {
  it("escapes &, <, > so arbitrary titles can't break or inject markup", () => {
    expect(escapeHtml("<b>Rock & Roll</b>")).toBe("&lt;b&gt;Rock &amp; Roll&lt;/b&gt;");
  });
});
