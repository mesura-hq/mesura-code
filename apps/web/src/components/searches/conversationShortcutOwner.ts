import { createContext, use } from "react";

import { useAgentSearchPopupStore } from "./agentSearchPopupStore";

/**
 * Mesura: which conversation a mounted ChatView is. The agent search popup
 * mounts a second ChatView over the main one, and every ChatView and composer
 * listens for its shortcuts on `window`; without an owner both would act on
 * one key press, stashing or editing the background draft from the popup.
 */
export const ConversationLayerContext = createContext<"main" | "agent-search">("main");

const popupOwnsShortcuts = () => useAgentSearchPopupStore.getState().open;
const mainOwnsShortcuts = () => !useAgentSearchPopupStore.getState().open;

/**
 * Whether this conversation's window shortcuts may act now: the popup's while
 * it is open, the main one's otherwise. The returned function is stable, so a
 * listener's effect does not re-register on each render.
 */
export function useConversationOwnsShortcuts(): () => boolean {
  return use(ConversationLayerContext) === "agent-search" ? popupOwnsShortcuts : mainOwnsShortcuts;
}

/** For listeners outside any ChatView (the palette): whether the popup has the keyboard. */
export function isAgentSearchPopupOpen(): boolean {
  return useAgentSearchPopupStore.getState().open;
}
