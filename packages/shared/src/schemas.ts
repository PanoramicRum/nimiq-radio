import { z } from "zod";

/** Request body for POST /api/prepare-song. */
export const PrepareSongBody = z.object({
  url: z.string().url(),
});
export type PrepareSongBody = z.infer<typeof PrepareSongBody>;

/**
 * Phase 3 placeholders (kept here so the contract is visible early; routes land later).
 * `sdkResult` is whatever the Mini App SDK returns from sendBasicTransactionWithData —
 * the backend normalizes it to a tx hash and verifies on-chain (see plan, Correctness note #1).
 */
export const SubmitBody = z.object({
  prepareId: z.string().min(1),
  sdkResult: z.string().min(1),
});
export type SubmitBody = z.infer<typeof SubmitBody>;

export const BoostBody = z.object({
  boostId: z.string().min(1),
  sdkResult: z.string().min(1),
});
export type BoostBody = z.infer<typeof BoostBody>;
