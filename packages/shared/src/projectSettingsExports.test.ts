// Public ESM resolution protects the removal of the obsolete defaults policy.
import { expect, it } from "vite-plus/test";

it("P2 regression the shared package exposes the unified resolver and rejects the obsolete workspace policy", () => {
  expect(import.meta.resolve("@t3tools/shared/projectSettings")).toMatch(/projectSettings\.ts$/);
  expect(() => import.meta.resolve("@t3tools/shared/threadEnvMode")).toThrow(
    expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
  );
});
