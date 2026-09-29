import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createFactoryEnvironmentAtoms, readFactorySnapshotState } from "./factory.ts";

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

describe("factoryRun subscription lifetime", () => {
  it("phase9 P1-1 ends a run stream within five seconds of the last reader unmounting", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const atom = createFactoryEnvironmentAtoms(runtime).factoryRun({
      environmentId: EnvironmentId.make("environment-1"),
      input: { threadId: ThreadId.make("thread-1"), runId: "invoice-csv-export" },
    });

    // The real family's atom, not a stand-in: a longer idle would keep the
    // server tailing the run's files after the Run tab closed.
    expect(atom.keepAlive).toBe(false);
    expect(atom.idleTTL).toBeGreaterThan(0);
    expect(atom.idleTTL).toBeLessThanOrEqual(5_000);
  });
});
