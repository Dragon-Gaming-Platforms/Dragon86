import { defineConfig } from "vite";
import path from "node:path";

/* ZenFS is replaced by a Map-backed stub: this test is about *which* copy of
   the image list wins, not about IndexedDB. */
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: { "@zenfs/core": path.resolve(import.meta.dirname, "fstub.ts") } },
  build: {
    ssr: true,
    outDir: path.resolve(import.meta.dirname, ".out"),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(import.meta.dirname, "entry.ts"), output: { entryFileNames: "t.mjs" } },
  },
});
