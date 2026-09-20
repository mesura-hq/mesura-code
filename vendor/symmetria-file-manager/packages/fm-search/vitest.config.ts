import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Both halves of the finder, under one runner.
 *
 * The engine's tests are plain Node and the overlay's need a DOM, so the DOM
 * environment is declared per file with a `@vitest-environment` docblock rather
 * than here — the panel package does the same, and for the same reason:
 * `environmentMatchGlobs` is gone in Vitest 4 and failed silently, which is
 * worse than not having it.
 *
 * `fileParallelism: false` is carried over from the panel's config and is not
 * caution. `topology.test.ts` forks real processes that share one store on
 * disk, and the renderer suites starve each other's `waitFor` timers when they
 * run in parallel — which produced flakes in two different files there that
 * were mistaken for product bugs.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    fileParallelism: false,
  },
});
