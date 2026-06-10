import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "nimiq-radio-theme";

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function savedTheme(): Theme | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s === "light" || s === "dark" ? s : null;
  } catch {
    return null;
  }
}

/**
 * Light/dark toggle. The app's colors are nimiq-css light-dark() tokens that follow the root's
 * `color-scheme`, so switching themes is just forcing that property. With no saved choice we leave
 * it unset and follow the OS; the first tap pins an explicit theme (persisted to localStorage, and
 * applied pre-paint by the inline script in index.html to avoid a flash).
 */
export function ThemeToggle() {
  const [override, setOverride] = useState<Theme | null>(savedTheme);
  const effective: Theme = override ?? systemTheme();

  useEffect(() => {
    if (!override) return; // no explicit choice yet -> leave color-scheme to the OS
    document.documentElement.style.colorScheme = override;
    try {
      localStorage.setItem(STORAGE_KEY, override);
    } catch {
      /* ignore */
    }
  }, [override]);

  const next: Theme = effective === "dark" ? "light" : "dark";
  return (
    <button
      className="theme-toggle"
      onClick={() => setOverride(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {effective === "dark" ? <SunGlyph /> : <MoonGlyph />}
    </button>
  );
}

function SunGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden focusable="false">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
