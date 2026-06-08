import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Proxy /api and /static to the backend in dev so the SPA and server share an origin.
// `host: true` exposes the dev server on the LAN for testing inside Nimiq Pay.
// Override the backend target with API_PROXY_TARGET (e.g. when HOST_PORT != 3000).
const target = process.env.API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/static": { target, changeOrigin: true },
      "/ws": { target, changeOrigin: true, ws: true },
    },
  },
});
