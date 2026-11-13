import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

// GitHub Pages project site: https://dragon-gaming-platforms.github.io/Dragon86/
// Override with PAGES_BASE=/ if you ever deploy to a domain root.
export default defineConfig({
  base: process.env.PAGES_BASE || "/Dragon86/",
  server: {
    host: true,
    allowedHosts: true,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: `${repoRoot}/index.html`,
        ps2: `${repoRoot}/ps2/index.html`,
      },
    },
  },
});
