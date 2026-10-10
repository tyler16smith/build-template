import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where `pnpm dev` serves the app, over HTTPS with the mkcert certificate it makes in `.certs/`. */
const HOST = "app.local.private";
const CERTS = new URL("../../.certs/", import.meta.url);

/** The Worker under `wrangler dev` (`pnpm dev` starts both). */
const WORKER = process.env.WORKER_ORIGIN ?? "http://127.0.0.1:8787";

// Everything the Worker serves goes to it, so the browser sees one origin, as in production.
const proxied = [
  "/api",
  "/auth",
  "/mcp",
  "/authorize",
  "/token",
  "/register",
  "/.well-known",
  "/hooks",
];

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Port 443 so the URL is plain https://app.local.private. macOS lets a non-root process bind it
    // only on all interfaces, hence `host: true`.
    host: true,
    port: 443,
    strictPort: true,
    // Only for the dev server: `vite build` (CI) has no certificate.
    https:
      command === "serve"
        ? {
            cert: readFileSync(new URL(`${HOST}.pem`, CERTS)),
            key: readFileSync(new URL(`${HOST}-key.pem`, CERTS)),
          }
        : undefined,
    proxy: {
      ...Object.fromEntries(proxied.map((path) => [path, { target: WORKER, changeOrigin: false }])),
      // The agents' WebSockets (the Assistant, the Automation Builder).
      "/agents": { target: WORKER, changeOrigin: false, ws: true },
    },
  },
}));
