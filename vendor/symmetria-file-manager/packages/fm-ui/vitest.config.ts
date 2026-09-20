import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The panel, tested under happy-dom.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // The DOM environment is declared per file with a `@vitest-environment`
    // docblock, not here: `environmentMatchGlobs` is gone in Vitest 4 and
    // failed silently, which is worse than not having it.
    //
    // `fileParallelism: false` is carried over from the application's config
    // and is not caution: the renderer suites starve each other's `waitFor`
    // timers when they run in parallel, which produced flakes in two different
    // files that were mistaken for product bugs.
    fileParallelism: false,
  },
});
