import { Icon } from "@iconify/react";

/**
 * Thin wrapper over the registered "nimiq" Iconify set (see main.tsx addCollection).
 * Icons render at 1em and inherit `currentColor`, so size/color them via the parent's
 * font-size and color.
 */
export function NqIcon({ name, className }: { name: string; className?: string }) {
  return <Icon icon={`nimiq:${name}`} className={className} aria-hidden />;
}
