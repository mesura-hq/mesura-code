import { describe, expect, it } from "vite-plus/test";

import type { ComposerHandleRef } from "~/composerHandleContext";

import { useAgentSearchPopupStore } from "./agentSearchPopupStore";
import { activeComposerHandle, registerAgentSearchComposer } from "./conversationShortcutOwner";

const handle = (): ComposerHandleRef => ({ current: null });

describe("activeComposerHandle", () => {
  it("gives the popup's composer while the popup is open, and the main one otherwise", () => {
    const main = handle();
    const popup = handle();
    const unregister = registerAgentSearchComposer(popup);
    try {
      useAgentSearchPopupStore.setState({ open: false });
      expect(activeComposerHandle(main)).toBe(main);
      useAgentSearchPopupStore.setState({ open: true });
      expect(activeComposerHandle(main)).toBe(popup);
    } finally {
      unregister();
      useAgentSearchPopupStore.setState({ open: false });
    }
  });

  it("falls back to the main composer when no popup conversation is mounted", () => {
    const main = handle();
    useAgentSearchPopupStore.setState({ open: true });
    try {
      expect(activeComposerHandle(main)).toBe(main);
    } finally {
      useAgentSearchPopupStore.setState({ open: false });
    }
  });

  it("an unregistered popup handle stops answering, and a newer one is not dropped by an older cleanup", () => {
    const main = handle();
    const first = handle();
    const second = handle();
    const unregisterFirst = registerAgentSearchComposer(first);
    const unregisterSecond = registerAgentSearchComposer(second);
    useAgentSearchPopupStore.setState({ open: true });
    try {
      unregisterFirst();
      expect(activeComposerHandle(main)).toBe(second);
      unregisterSecond();
      expect(activeComposerHandle(main)).toBe(main);
    } finally {
      useAgentSearchPopupStore.setState({ open: false });
    }
  });
});
