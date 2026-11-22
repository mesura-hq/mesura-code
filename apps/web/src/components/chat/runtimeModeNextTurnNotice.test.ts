import { describe, expect, it } from "vite-plus/test";

import { runtimeModeChangeWaitsForNextTurn } from "./runtimeModeNextTurnNotice";

describe("runtimeModeChangeWaitsForNextTurn", () => {
  it("waits when a turn runs and the pick differs from the saved mode", () => {
    expect(
      runtimeModeChangeWaitsForNextTurn({
        activeRunId: "run-1",
        savedMode: "approval-required",
        nextMode: "full-access",
      }),
    ).toBe(true);
  });

  it("does not wait without a running turn", () => {
    expect(
      runtimeModeChangeWaitsForNextTurn({
        activeRunId: null,
        savedMode: "approval-required",
        nextMode: "full-access",
      }),
    ).toBe(false);
  });

  it("does not wait when the pick equals the saved mode", () => {
    expect(
      runtimeModeChangeWaitsForNextTurn({
        activeRunId: "run-1",
        savedMode: "full-access",
        nextMode: "full-access",
      }),
    ).toBe(false);
  });

  it("does not wait for a thread with no saved mode yet", () => {
    expect(
      runtimeModeChangeWaitsForNextTurn({
        activeRunId: "run-1",
        savedMode: undefined,
        nextMode: "full-access",
      }),
    ).toBe(false);
  });
});
