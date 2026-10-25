import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import {
  initialAgentSearchPopupState,
  reduceAgentSearchPopup,
  type AgentSearchPopupAction,
  type AgentSearchPopupState,
} from "./agentSearchPopup.logic";

interface AgentSearchPopupStore extends AgentSearchPopupState {
  /**
   * Queries waiting to be sent as their search's first message, by thread key.
   * The start RPC answers before the thread's shell reaches this client, and
   * the turn needs the shell's runtime mode.
   */
  readonly firstMessages: ReadonlyMap<string, { search: ScopedThreadRef; text: string }>;
  readonly dispatch: (action: AgentSearchPopupAction) => void;
}

/** Mesura: one agent search popup per tab, in memory like the project filter. */
export const useAgentSearchPopupStore = create<AgentSearchPopupStore>()((set) => ({
  ...initialAgentSearchPopupState,
  firstMessages: new Map(),
  dispatch: (action) => set((state) => reduceAgentSearchPopup(state, action)),
}));

export function dispatchAgentSearchPopup(action: AgentSearchPopupAction): void {
  useAgentSearchPopupStore.getState().dispatch(action);
}

/**
 * Closes the popup before the workspace behind it takes the keyboard (a file pane, a right-panel
 * surface, a pane chord), as a focus chord over the open palette closes the palette. The search
 * keeps running and the sparkle reopens it.
 */
export function closeAgentSearchPopupForWorkspace(): void {
  if (useAgentSearchPopupStore.getState().open) dispatchAgentSearchPopup({ type: "close" });
}

export function queueSearchFirstMessage(search: ScopedThreadRef, text: string): void {
  useAgentSearchPopupStore.setState((state) => ({
    firstMessages: new Map(state.firstMessages).set(scopedThreadKey(search), { search, text }),
  }));
}

/** Removes and returns the query waiting for `search`, so it is sent once. */
export function takeSearchFirstMessage(search: ScopedThreadRef): string | null {
  const key = scopedThreadKey(search);
  const pending = useAgentSearchPopupStore.getState().firstMessages.get(key);
  if (!pending) return null;
  useAgentSearchPopupStore.setState((state) => {
    const firstMessages = new Map(state.firstMessages);
    firstMessages.delete(key);
    return { firstMessages };
  });
  return pending.text;
}
