import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { addCollection } from "@iconify/react";

// Nimiq design system (plain CSS, all wrapped in @layer so our unlayered index.css wins).
import "nimiq-css/css/index.css";
// Mulish is referenced by nimiq-css but its fonts.css points at /assets paths that don't ship,
// so self-host the weights we use via Fontsource instead.
import "@fontsource/mulish/400.css";
import "@fontsource/mulish/600.css";
import "@fontsource/mulish/700.css";
import "@fontsource/mulish/800.css";
import "@fontsource/fira-mono/400.css";

import nimiqIcons from "nimiq-icons/icons.json";
import { App } from "./App";
import "./index.css"; // app overrides + token alias remap — imported last so it wins the cascade

// Register the "nimiq" Iconify collection once so <Icon icon="nimiq:..."/> resolves offline.
addCollection(nimiqIcons as Parameters<typeof addCollection>[0]);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
