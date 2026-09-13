import { describe, expect, it } from "vite-plus/test";

import * as Cause from "effect/Cause";
import { EditorSessionLookupError, EditorSessionSpawnError } from "@t3tools/contracts";

import { describeFallback, fallbackFromCause, isSettingsFixable } from "./nvimFallback.ts";

describe("describeFallback", () => {
  it("says what is wrong and where", () => {
    expect(describeFallback({ reason: "config-missing", detail: "/home/dev/.neovim" })).toBe(
      "that configuration directory is not there — /home/dev/.neovim",
    );
  });

  it("tells a missing binary from a version that is too old", () => {
    // The whole reason the launch's reasons are carried through unchanged: the
    // two have different fixes, and one message for both is no message.
    expect(describeFallback({ reason: "binary-missing", detail: "" })).toBe(
      "Neovim is not on this machine's PATH",
    );
    expect(describeFallback({ reason: "version", detail: "0.10.2, need 0.12.0" })).toBe(
      "this Neovim is too old — 0.10.2, need 0.12.0",
    );
  });

  it("drops a detail that is only whitespace", () => {
    expect(describeFallback({ reason: "spawn-failed", detail: "   " })).toBe(
      "Neovim would not start",
    );
  });
});

describe("isSettingsFixable", () => {
  it("knows which reasons point at a setting", () => {
    expect(isSettingsFixable("config-missing")).toBe(true);
    expect(isSettingsFixable("spawn-failed")).toBe(false);
    expect(isSettingsFixable("runtime-unwritable")).toBe(false);
  });
});

describe("fallbackFromCause", () => {
  it("finds the spawn failure inside the cause", () => {
    // The shape that was wrong once: an atom command's failure carries a
    // `Cause`, and the typed error is inside its `reasons`. Reading `reason`
    // off the cause itself finds nothing and finds it silently.
    const cause = Cause.fail(
      new EditorSessionSpawnError({
        threadId: "thread-1",
        reason: "config-missing",
        detail: "/home/dev/.neovim",
      }),
    );
    expect(fallbackFromCause(cause)).toEqual({
      reason: "config-missing",
      detail: "/home/dev/.neovim",
    });
  });

  it("leaves a session alone for an error that is not a spawn failure", () => {
    // A lookup that raced a close is transient. Turning the editor into a
    // plain one for it is a worse answer than waiting.
    const cause = Cause.fail(new EditorSessionLookupError({ threadId: "thread-1" }));
    expect(fallbackFromCause(cause)).toBeNull();
  });

  it("finds nothing in a defect, and does not throw looking", () => {
    expect(fallbackFromCause(Cause.die(new Error("boom")))).toBeNull();
    expect(fallbackFromCause(null)).toBeNull();
    expect(fallbackFromCause({})).toBeNull();
  });
});
