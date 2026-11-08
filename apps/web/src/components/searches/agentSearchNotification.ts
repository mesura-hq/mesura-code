import type { ScopedThreadRef } from "@t3tools/contracts";

import { dispatchAgentSearchPopup } from "./agentSearchPopupStore";

/**
 * The title a finished agent search announces itself under, in app and on the
 * desktop. The shell does not carry `find_threads` results, so no match count.
 */
export const AGENT_SEARCH_FINISHED_TITLE = "Agent search finished";

/**
 * Three times a finished thread's 5 s toast: the result's Open has to be
 * reachable after reading the title. The sparkle's dot stays until it is opened.
 */
export const AGENT_SEARCH_TOAST_TIMEOUT_MS = 15_000;

export function openAgentSearch(search: ScopedThreadRef): void {
  dispatchAgentSearchPopup({ type: "open", search });
}
