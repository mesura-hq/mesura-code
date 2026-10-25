import { createContext, use } from "react";

import type { ComposerHandleRef } from "~/composerHandleContext";

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

let agentSearchComposer: ComposerHandleRef | null = null;

/** The popup's conversation registers its composer handle while it is mounted. */
export function registerAgentSearchComposer(handle: ComposerHandleRef): () => void {
  agentSearchComposer = handle;
  return () => {
    if (agentSearchComposer === handle) agentSearchComposer = null;
  };
}

/**
 * The composer that surfaces outside any ChatView (the palette, the file manager, the file tree)
 * act on: the popup's while it is open, else the main one they were given. Read it at the moment
 * of use, not at render, so a popup opened meanwhile is honoured.
 */
export function activeComposerHandle(main: ComposerHandleRef | null): ComposerHandleRef | null {
  return isAgentSearchPopupOpen() && agentSearchComposer !== null ? agentSearchComposer : main;
}
