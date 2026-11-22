import { describe, expect, it } from "vite-plus/test";

import { runtimeModeChangeWaitsForNextTurn } from "./runtimeModeNextTurnNotice";

describe("runtimeModeChangeWaitsForNextTurn", () => {
  it("waits when a turn runs with a different mode", () => {
    expect(
      runtimeModeChangeWaitsForNextTurn({
        activeRunId: "run-1",
        runningMode: "approval-required",
        nextMode: "full-access",
      }),
    ).toBe(true);
  });

  it("does not wait without a running turn", () => {
    expect(
      runtimeModeChangeWaitsForNextTurn({
        activeRunId: null,
        runningMode: "approval-required",
        nextMode: "full-access",
      }),
    ).toBe(false);
  });

  it("does not wait when the pick returns to the running mode", () => {
    expect(
      runtimeModeChangeWaitsForNextTurn({
        activeRunId: "run-1",
        runningMode: "full-access",
        nextMode: "full-access",
      }),
    ).toBe(false);
  });

  it("does not wait for a thread with no saved mode yet", () => {
    expect(
      runtimeModeChangeWaitsForNextTurn({
        activeRunId: "run-1",
        runningMode: undefined,
        nextMode: "full-access",
      }),
    ).toBe(false);
  });
});
