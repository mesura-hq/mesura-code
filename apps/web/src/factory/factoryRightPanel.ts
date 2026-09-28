import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../rightPanelStore";

/**
 * The plan card's Open: the plan in the Factory surface, maximized where the
 * panel sits beside the chat. The caller passes its own maximize setter
 * because the chat view's toggle reads `canMaximizeRightPanel` from the render
 * before this click, when the panel may still be closed. Where the panel is a
 * sheet it already covers the chat, so it opens without maximizing.
 */
export function openFactoryPlanInRightPanel(input: {
  ref: ScopedThreadRef;
  /** The `factory.plan` activity id. */
  planId: string;
  maximizeKey: string;
  useRightPanelSheet: boolean;
  setMaximizedRightPanelThreadKey: (threadKey: string | null) => void;
}): void {
  useRightPanelStore.getState().openFactory(input.ref, { tab: "plan", planId: input.planId });
  if (!input.useRightPanelSheet) input.setMaximizedRightPanelThreadKey(input.maximizeKey);
}
