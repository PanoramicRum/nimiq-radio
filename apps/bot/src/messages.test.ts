import type { AppConfig, QueueItem, RadioState } from "@radio/shared";
import { describe, expect, it } from "vitest";

import { buildNotificationMessage, buildNowPlayingMessage, buildQueueMessage, buildStatsMessage } from "./messages";

function song(over: Partial<QueueItem> = {}): QueueItem {
  return { id: "u1", sourceUrl: "https://x", trackUrl: "/t.m4a", title: "Song", author: "Artist", amountPaid: 0, createdAt: "2026-01-01T00:00:00Z", status: "ready", ...over };
}
function makeState(over: Partial<RadioState> = {}): RadioState {
  return { current: null, startedAtServerMs: null, queue: [], paused: false, seq: 1, listeners: 0, serverNowMs: 0, ...over };
}
const freeCfg: AppConfig = { paymentsEnabled: false, network: "mainnet", recipientAddress: null, priceLuna: 0, minConfirmations: 10 };
const paidCfg: AppConfig = { ...freeCfg, paymentsEnabled: true, recipientAddress: "NQ..", priceLuna: 100_000 };

describe("buildQueueMessage", () => {
  it("shows idle when nothing is playing and the queue is empty", () => {
    const msg = buildQueueMessage(makeState(), freeCfg, 10);
    expect(msg).toContain("Nothing playing");
    expect(msg).toContain("No songs queued");
  });

  it("labels filler distinctly from a user song", () => {
    const filler = buildQueueMessage(makeState({ current: song({ title: "CC0 Track", isRadio: true }) }), freeCfg, 10);
    expect(filler).toContain("📻 Filler");
  });

  it("numbers the upcoming queue and escapes titles", () => {
    const msg = buildQueueMessage(makeState({ current: song(), queue: [song({ title: "A & B", id: "q1" }), song({ id: "q2", title: "C" })] }), freeCfg, 10);
    expect(msg).toContain("1. <b>A &amp; B</b>");
    expect(msg).toContain("2. <b>C</b>");
  });

  it("shows paid amounts only when payments are enabled", () => {
    const queue = [song({ id: "q1", amountPaid: 100_000 })];
    expect(buildQueueMessage(makeState({ queue }), paidCfg, 10)).toContain("NIM");
    expect(buildQueueMessage(makeState({ queue }), freeCfg, 10)).not.toContain("NIM");
  });

  it("truncates past the display limit with a remainder line", () => {
    const queue = Array.from({ length: 5 }, (_, i) => song({ id: `q${i}`, title: `T${i}` }));
    const msg = buildQueueMessage(makeState({ queue }), freeCfg, 2);
    expect(msg).toContain("…and 3 more");
    expect(msg).not.toContain("T2"); // beyond the limit
  });
});

describe("buildNowPlayingMessage / buildStatsMessage / buildNotificationMessage", () => {
  it("now playing surfaces the submitter when present", () => {
    const msg = buildNowPlayingMessage(makeState({ current: song({ submittedBy: "NQ12 ABCD EFGH IJKL MNOP QRST UVWX YZ12" }) }));
    expect(msg).toContain("Added by");
  });

  it("stats reports queue size and paid/free split", () => {
    const msg = buildStatsMessage(makeState({ queue: [song({ amountPaid: 100_000 }), song({ id: "q2" })], listeners: 3 }));
    expect(msg).toContain("2 songs");
    expect(msg).toContain("1 paid");
    expect(msg).toContain("3 listeners");
  });

  it("notification names the leading user song", () => {
    expect(buildNotificationMessage(makeState({ current: song({ title: "Hello" }) }))).toContain("Hello");
    expect(buildNotificationMessage(makeState({ current: song({ isRadio: true }), queue: [song({ id: "q1", title: "Queued" })] }))).toContain("Queued");
  });
});
