import type { FailureCode } from "@symmetria/fm-core/contract";
import { PUSH_CHANNELS, REQUEST_CHANNELS } from "@symmetria/fm-main/ipc/channels";
import {
  FILE_MANAGER_PUSH_CHANNELS,
  FILE_MANAGER_READ_CHANNELS,
  FILE_MANAGER_WRITE_CHANNELS,
  type FileManagerFailureCode,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { expectTypeOf } from "vite-plus/test";

/**
 * The contract's channel literals are a copy of the file manager's own channel
 * table, kept in `packages/contracts` so mobile never depends on the vendored
 * package. This is the guard that makes a vendor pull adding a channel fail
 * here, in one line, instead of as an `unknown channel` reply at runtime.
 */
describe("file manager channel parity", () => {
  it("covers every request channel of the vendored file manager exactly once", () => {
    const declared = [...FILE_MANAGER_READ_CHANNELS, ...FILE_MANAGER_WRITE_CHANNELS].sort();
    expect(declared).toEqual(Object.values(REQUEST_CHANNELS).sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("names exactly the failure codes the vendored file manager can answer with", () => {
    // fm-core exports the codes as a type only, so parity is a type-level fact.
    expectTypeOf<FileManagerFailureCode>().toEqualTypeOf<FailureCode>();
  });

  it("covers every push channel of the vendored file manager", () => {
    expect([...FILE_MANAGER_PUSH_CHANNELS].sort()).toEqual(Object.values(PUSH_CHANNELS).sort());
  });
});
