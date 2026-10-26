import { defineConfig } from "vite";
import { resolve } from "node:path";

/* Build src/bridge/p9.ts as CommonJS so tools/vm/boot.mjs can require it. */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "build"),
    emptyOutDir: true,
    ssr: true,
    target: "node20",
    minify: false,
    lib: {
      entry: resolve(__dirname, "p9-entry.ts"),
      formats: ["cjs"],
      fileName: () => "p9.cjs",
    },
    rollupOptions: { output: { entryFileNames: "p9.cjs" } },
  },
});
