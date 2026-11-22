import type { RuntimeMode } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { runtimeModeConfig } from "./runtimeModeConfig";

/**
 * Providers take permissions when a turn starts, so a mid-turn pick mostly misses the running turn.
 * MCP calls and steer restarts can read the saved mode sooner, so the notice does not promise more.
 */
export function noticeRuntimeModeChangeDuringTurn(input: {
  readonly activeRunId: string | null | undefined;
  readonly nextMode: RuntimeMode;
}): void {
  if (input.activeRunId == null) return;
  toastManager.add({
    type: "info",
    title: `${runtimeModeConfig[input.nextMode].label} may not reach the running turn`,
    description: "A turn usually keeps the permissions it started with until it ends.",
  });
}
