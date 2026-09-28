import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { readFactorySnapshotState } from "./factory.ts";

describe("readFactorySnapshotState", () => {
  it("returns the same ready state for the same snapshot result, so a card memo does not reparse the plan", () => {
    const result = AsyncResult.success({ digest: "a".repeat(64), markdown: "# Plan\n" });
    const first = readFactorySnapshotState(result);
    expect(first).toEqual({ status: "ready", markdown: "# Plan\n" });
    expect(readFactorySnapshotState(result)).toBe(first);
    expect(
      readFactorySnapshotState(
        AsyncResult.success({ digest: "b".repeat(64), markdown: "# Other\n" }),
      ),
    ).not.toBe(first);
  });

  it("maps a pending snapshot to loading and a failed one to failed, each a stable state", () => {
    const loading = readFactorySnapshotState(AsyncResult.initial(true));
    expect(loading).toEqual({ status: "loading" });
    expect(readFactorySnapshotState(AsyncResult.initial(true))).toBe(loading);
    const failed = readFactorySnapshotState(
      AsyncResult.failure<never, Error>(Cause.fail(new Error("not found"))),
    );
    expect(failed).toEqual({ status: "failed" });
  });
});

describe("readFactorySnapshotState after a connection drop", () => {
  it("keeps rendering a plan body already loaded when the snapshot query later fails", () => {
    const loaded = AsyncResult.success({ digest: "a".repeat(64), markdown: "# Plan\n" });
    const ready = readFactorySnapshotState(loaded);
    const offline = AsyncResult.failureWithPrevious<{ digest: string; markdown: string }, Error>(
      Cause.fail(new Error("Environment env-1 is offline.")),
      { previous: Option.some(loaded) },
    );

    expect(readFactorySnapshotState(offline)).toBe(ready);
  });
});
