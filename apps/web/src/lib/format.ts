import { LUNA_PER_NIM } from "@radio/shared";

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function lunaToNim(luna: number): string {
  return (luna / LUNA_PER_NIM).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** "NQ12 ABCD … WXYZ" — compact a Nimiq address for display. */
export function shortAddress(addr: string): string {
  const compact = addr.replace(/\s+/g, "");
  if (compact.length <= 12) return addr;
  return `${compact.slice(0, 8)}…${compact.slice(-4)}`;
}

/** "free" while unpaid (Phase 2); "<n> NIM" once payments land (Phase 3+). */
export function formatPaid(amountLuna: number): string {
  return amountLuna > 0 ? `${lunaToNim(amountLuna)} NIM` : "free";
}
