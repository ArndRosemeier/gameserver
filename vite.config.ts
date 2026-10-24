import { defineConfig } from "vite";

// Root is example/; the shared client lives in ../client and is imported directly.
export default defineConfig({
  root: "example",
  envDir: ".",
  server: { port: 5174 },
  build: { outDir: "../dist", emptyOutDir: true },
});
