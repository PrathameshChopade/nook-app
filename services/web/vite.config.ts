import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxying in development means the browser only ever talks to one origin,
    // so there is no CORS configuration here that would then differ from
    // production, where an Ingress puts them on one origin anyway.
    proxy: {
      "/v1": { target: "http://localhost:3000", changeOrigin: true },
      "/collab": {
        target: "ws://localhost:3001",
        ws: true,
        rewrite: (p) => p.replace(/^\/collab/, ""),
      },
    },
  },
  build: {
    // Hashed filenames so the CDN cache headers in stage 03 can be
    // aggressive: an immutable asset name means a one-year max-age is safe.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash].[ext]",
      },
    },
  },
});
