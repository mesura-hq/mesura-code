import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The renderer only. The main process and the preload are bundled by esbuild in
// `scripts/build.mjs`, because they are Node targets and Vite's browser
// defaults are wrong for them.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Relative asset URLs: the window loads the built page over `file://`, where
  // an absolute `/assets/...` path resolves to the filesystem root.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist-electron/renderer",
    emptyOutDir: true,
    target: "chrome146",
  },
});
