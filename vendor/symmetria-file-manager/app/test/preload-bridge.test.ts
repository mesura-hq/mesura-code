import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRIDGE_KEY } from "@symmetria/fm-core/bridge";
import { describe, expect, it } from "vitest";

const preloadSource = readFileSync(
  fileURLToPath(new URL("../src/preload/index.ts", import.meta.url)),
  "utf8",
);

// Acceptance criterion 6 of phase 2. Asserted against the source rather than
// against a running preload, because `contextBridge` only exists inside a real
// Electron renderer — and because the property worth pinning is "exactly one",
// which is a fact about the file, not about a run.
describe("the preload bridge", () => {
  it("exposes exactly one global and nothing else", () => {
    const calls = preloadSource.match(/exposeInMainWorld\s*\(/g) ?? [];

    expect(calls).toHaveLength(1);
  });

  it("exposes it under the declared key", () => {
    expect(BRIDGE_KEY).toBeTypeOf("string");
    expect(BRIDGE_KEY).not.toBe("");
    expect(preloadSource).toContain("BRIDGE_KEY");
  });
});
