import { defineConfig } from "vitest/config";

// The privileged half, tested without an application around it. Node only:
// nothing here needs a DOM, which is the same fact this package's tsconfig
// states at compile time.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
