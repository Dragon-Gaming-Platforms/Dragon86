import { defineConfig } from "vite";

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
  },
});
