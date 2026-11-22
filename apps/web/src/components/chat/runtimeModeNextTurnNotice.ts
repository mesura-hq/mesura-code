import type { RuntimeMode } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { runtimeModeConfig } from "./runtimeModeConfig";

interface RuntimeModeChangeDuringTurn {
  readonly activeRunId: string | null | undefined;
  readonly savedMode: RuntimeMode | undefined;
  readonly nextMode: RuntimeMode;
}

/**
 * The provider takes its permissions when a turn starts, so a pick made mid-turn waits for the next one.
 * The saved mode can already differ from the running turn's (a queued send saves it), so the notice names neither.
 */
export function runtimeModeChangeWaitsForNextTurn(input: RuntimeModeChangeDuringTurn): boolean {
  return (
    input.activeRunId != null && input.savedMode !== undefined && input.nextMode !== input.savedMode
  );
}

export function noticeRuntimeModeChangeDuringTurn(input: RuntimeModeChangeDuringTurn): void {
  if (!runtimeModeChangeWaitsForNextTurn(input)) return;
  toastManager.add({
    type: "info",
    title: `${runtimeModeConfig[input.nextMode].label} starts with the next turn`,
    description: "The running turn keeps its permissions, including messages you steer into it.",
  });
}
