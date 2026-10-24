import { defineConfig } from "vite";

// The lobby page. Served from https://apps.futuremagic.de/lobby/ - asset URLs must be relative.
// In dev, /apps.json and /shots/ are proxied to the live site so the page sees the real registry.
export default defineConfig({
  root: "lobby",
  base: "./",
  envDir: ".",
  server: {
    port: 5175,
    proxy: {
      "/apps.json": { target: "https://apps.futuremagic.de", changeOrigin: true },
      "/shots": { target: "https://apps.futuremagic.de", changeOrigin: true },
    },
  },
  build: { outDir: "../dist-lobby", emptyOutDir: true },
});
