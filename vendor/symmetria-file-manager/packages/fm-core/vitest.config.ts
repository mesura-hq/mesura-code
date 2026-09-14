import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Bounded because a host workspace runs this suite beside other packages'
    // pools under `vp run --parallel`; an unbounded pool sizes itself to the
    // machine and multiplies with every neighbour.
    maxWorkers: 6,
  },
});
