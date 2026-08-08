import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page and the API are two processes in development and one in production.
// Vite owns the module graph while developing and proxies everything the app
// asks the dashboard for; `npm start` builds into dist/ and Hono serves it.

const API_PORT = 4000;

const target = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  root: fileURLToPath(new URL("src/web", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src/web", import.meta.url)),
    },
  },
  server: {
    port: 4001,
    strictPort: true,
    /*
     * `changeOrigin` rewrites Host but leaves Origin alone, so anything proxied
     * from :4001 arrives still claiming that origin — and the dashboard refuses
     * it, correctly: a mismatched Origin is the shape of a cross-site request,
     * which is the whole reason the guard exists.
     *
     * Both hops need the rewrite, and they need different hooks: `proxyReq` for
     * ordinary requests, `proxyReqWs` for the upgrade. Setting it here keeps the
     * guard exactly as strict in development as in production, rather than
     * teaching the server to trust an extra port.
     */
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("origin", target));
        },
      },
      "/ws": {
        target,
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyReq) => proxyReq.setHeader("origin", target));
        },
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("dist", import.meta.url)),
    emptyOutDir: true,
  },
});
