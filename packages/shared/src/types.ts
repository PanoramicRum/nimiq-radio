import type { TrackStatus } from "./constants";

/**
 * A song in the radio system. Shape mirrors Project_description.md exactly,
 * extended only where the docs require it. The same shape is the DB row (Phase 2+),
 * the API response item, and the WS broadcast item — one source of truth.
 */
export type QueueItem = {
  id: string;
  sourceUrl: string;
  trackUrl: string;
  title: string;
  author?: string;
  /** Usually only present for music.youtube.com submissions. */
  album?: string;
  /** Public path to cover art, e.g. "/static/covers/<id>.jpg". Absent when unresolved. */
  coverUrl?: string;
  /** Seconds. */
  duration?: number;
  /** Nimiq address that paid — derived from chain, never trusted from the client (Phase 3+). */
  submittedBy?: string;
  /** Total Luna paid across the initial submit + all boosts. 0 until payments (Phase 3). */
  amountPaid: number;
  /** ISO timestamp. */
  createdAt: string;
  status: TrackStatus;
};

/**
 * On-chain payment record. The backend re-derives every field from the Nimiq
 * network; the frontend is never trusted for amount or sender (Phase 3+).
 */
export type PaymentInfo = {
  txHash: string;
  senderAddress: string;
  recipientAddress: string;
  amountLuna: number;
  /** ISO timestamp, set once confirmations >= MIN_CONFIRMATIONS. */
  confirmedAt?: string;
};

/**
 * Server-authoritative playback state, broadcast over WS (Phase 5) and returned
 * by GET /api/state (Phase 2). Clients render this; they never own playback truth.
 */
export type RadioState = {
  current: QueueItem | null;
  /** Server epoch ms when the current track started. null when idle. */
  startedAtServerMs: number | null;
  /** Upcoming queue, already sorted (amountPaid desc, createdAt asc). Index = queue position. */
  queue: QueueItem[];
  paused: boolean;
  /** Monotonic; clients request a full resync if they fall behind. */
  seq: number;
  /** Live listener count (connected WebSocket clients). */
  listeners: number;
  /** Server clock at snapshot time — lets a fresh client estimate its offset before WS probing. */
  serverNowMs: number;
};

/** Real-time WebSocket messages (Phase 5). */
export type ClientWsMessage =
  | { type: "clockProbe"; t0: number } // t0 = client send time
  | { type: "resync"; seq: number };

export type ServerWsMessage =
  | { type: "state"; state: RadioState }
  | { type: "clockProbeReply"; t0: number; t1: number; t2: number } // t1=server recv, t2=server send
  | { type: "ping" };

/** Public-safe runtime config the SPA reads from GET /api/config to pick its flow. */
export type AppConfig = {
  /** When false, songs are added for free (Phases 1–2). When true, a NIM payment is required. */
  paymentsEnabled: boolean;
  network: "mainnet" | "testnet";
  /** The address payments must go to (null when payments are disabled). */
  recipientAddress: string | null;
  /** Minimum price per song, in Luna. */
  priceLuna: number;
  /** Confirmations required before a paid song is queued. */
  minConfirmations: number;
};

/** Metadata common to both prepare-song outcomes. */
type PreparedMeta = {
  trackUrl: string;
  title: string;
  author?: string;
  album?: string;
  duration?: number;
};

/**
 * Response for POST /api/prepare-song.
 *  - free mode: the song is already enqueued; just refresh state.
 *  - paid mode: the song is staged (NOT enqueued); pay `priceLuna` to `recipientAddress`
 *    with `orderId` in the transaction's data, then POST /api/submit.
 */
export type PrepareSongResponse =
  | ({ success: true; mode: "free" } & PreparedMeta)
  | ({
      success: true;
      mode: "paid";
      prepareId: string;
      orderId: string;
      priceLuna: number;
      recipientAddress: string;
    } & PreparedMeta)
  | { success: false; error: string };

/** Shared failure codes for the verify-and-act endpoints (submit, boost). */
export type PaymentFailureCode =
  | "pending" // not yet confirmed on-chain — the client should retry shortly
  | "not_found"
  | "wrong_recipient"
  | "underpaid"
  | "wrong_network"
  | "order_mismatch"
  | "replay"
  | "expired"
  | "bad_result"
  | "disabled"
  | "error";

/** Response for POST /api/submit (paid mode). */
export type SubmitResponse =
  | { success: true; queued: QueueItem }
  | { success: false; code: PaymentFailureCode; error: string };

/** Response for GET /api/boost-intent (paid mode) — issues an order id to pay a boost against. */
export type BoostIntentResponse =
  | {
      success: true;
      boostId: string;
      orderId: string;
      /** Minimum boost in Luna; the user may pay more to rank higher. */
      minLuna: number;
      recipientAddress: string;
      queueItemId: string;
    }
  | { success: false; error: string };

/** Response for POST /api/boost (paid mode). "gone" = the song already left the queue. */
export type BoostResponse =
  | { success: true; item: QueueItem }
  | { success: false; code: PaymentFailureCode | "gone"; error: string };
