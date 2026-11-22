import type { RuntimeMode } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { runtimeModeConfig } from "./runtimeModeConfig";

interface RuntimeModeChangeDuringTurn {
  readonly activeRunId: string | null | undefined;
  /** The thread's saved mode, which the running turn started with. */
  readonly runningMode: RuntimeMode | undefined;
  readonly nextMode: RuntimeMode;
}

/** The provider takes its permissions when a turn starts, so a change made mid-turn waits for the next message. */
export function runtimeModeChangeWaitsForNextTurn(input: RuntimeModeChangeDuringTurn): boolean {
  return (
    input.activeRunId != null &&
    input.runningMode !== undefined &&
    input.nextMode !== input.runningMode
  );
}

export function noticeRuntimeModeChangeDuringTurn(input: RuntimeModeChangeDuringTurn): void {
  if (!runtimeModeChangeWaitsForNextTurn(input) || input.runningMode === undefined) return;
  toastManager.add({
    type: "info",
    title: `${runtimeModeConfig[input.nextMode].label} applies from your next message`,
    description: `The running turn keeps ${runtimeModeConfig[input.runningMode].label}.`,
  });
}
