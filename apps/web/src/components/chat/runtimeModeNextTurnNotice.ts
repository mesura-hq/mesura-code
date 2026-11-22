import type { RuntimeMode } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { runtimeModeConfig } from "./runtimeModeConfig";

/**
 * A pick is saved on send and the provider takes its permissions when a turn starts, so a pick made
 * mid-turn never reaches the running turn, its steered messages or queued ones. The caller skips re-picks.
 */
export function noticeRuntimeModeChangeDuringTurn(input: {
  readonly activeRunId: string | null | undefined;
  readonly nextMode: RuntimeMode;
}): void {
  if (input.activeRunId == null) return;
  toastManager.add({
    type: "info",
    title: `${runtimeModeConfig[input.nextMode].label} is saved when you send`,
    description:
      "It applies to the next turn that starts after that. The running turn and messages already queued keep their permissions.",
  });
}
