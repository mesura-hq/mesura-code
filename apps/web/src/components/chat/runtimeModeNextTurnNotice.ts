import type { RuntimeMode } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { runtimeModeConfig } from "./runtimeModeConfig";

/**
 * The provider takes its permissions when a turn starts, so a pick made mid-turn never reaches the
 * running turn. When it applies later depends on queue and send paths, so the notice claims only that.
 */
export function noticeRuntimeModeChangeDuringTurn(input: {
  readonly activeRunId: string | null | undefined;
  readonly nextMode: RuntimeMode;
}): void {
  if (input.activeRunId == null) return;
  toastManager.add({
    type: "info",
    title: `${runtimeModeConfig[input.nextMode].label} does not change the running turn`,
    description: "The running turn keeps its permissions until it ends.",
  });
}
