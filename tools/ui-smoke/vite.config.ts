import { defineConfig } from "vite";
import { resolve } from "node:path";

/* Bundles the whole OS as one IIFE so a headless test can load it into a
   simulated page. Not shipped; only tools/ui-smoke/run.mjs uses it. */
export default defineConfig({
  root: resolve(__dirname, "../.."),
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "out"),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "../../src/main.ts"),
      formats: ["iife"],
      name: "D86Smoke",
      fileName: () => "os.js",
    },
    minify: false,
    cssCodeSplit: false,
  },
});
