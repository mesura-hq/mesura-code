import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore, type FactoryPanelSelection } from "../rightPanelStore";

interface FactoryOpenTarget {
  ref: ScopedThreadRef;
  maximizeKey: string;
  useRightPanelSheet: boolean;
  setMaximizedRightPanelThreadKey: (threadKey: string | null) => void;
}

function openFactoryInRightPanel(target: FactoryOpenTarget, selection: FactoryPanelSelection) {
  useRightPanelStore.getState().openFactory(target.ref, selection);
  if (!target.useRightPanelSheet) target.setMaximizedRightPanelThreadKey(target.maximizeKey);
}

/**
 * The plan card's Open: the plan in the Factory surface, maximized where the
 * panel sits beside the chat. The caller passes its own maximize setter
 * because the chat view's toggle reads `canMaximizeRightPanel` from the render
 * before this click, when the panel may still be closed. Where the panel is a
 * sheet it already covers the chat, so it opens without maximizing.
 */
export function openFactoryPlanInRightPanel(
  input: FactoryOpenTarget & {
    /** The `factory.plan` activity id. */
    planId: string;
  },
): void {
  openFactoryInRightPanel(input, { tab: "plan", planId: input.planId });
}

/**
 * The run card's Open: the Factory surface for that run, opened the way the
 * plan card's Open is. The surface shows the thread's latest plan until the
 * Run tab is enabled (phase 9 of factory-in-chat), which reads `runId`.
 */
export function openFactoryRunInRightPanel(
  input: FactoryOpenTarget & {
    /** The run directory's name. */
    runId: string;
  },
): void {
  openFactoryInRightPanel(input, { tab: "plan", planId: null, runId: input.runId });
}
