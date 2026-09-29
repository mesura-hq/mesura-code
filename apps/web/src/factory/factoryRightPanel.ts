import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore, type FactoryPanelSelection } from "../rightPanelStore";

interface FactoryOpenTarget {
  ref: ScopedThreadRef;
  maximizeKey: string;
  setMaximizedRightPanelThreadKey: (threadKey: string | null) => void;
}

function openFactoryInRightPanel(target: FactoryOpenTarget, selection: FactoryPanelSelection) {
  useRightPanelStore.getState().openFactory(target.ref, selection);
  // Set even where the panel is a sheet, which ignores it (`canMaximizeRightPanel`
  // is false there). Skipping it on a narrow window left the pane unmaximized
  // once the window widened to the inline layout: phase 9's verify ① found that
  // opening at the sheet width and resizing to 1440 px.
  target.setMaximizedRightPanelThreadKey(target.maximizeKey);
}

/**
 * The plan card's Open: the plan in the Factory surface, maximized where the
 * panel sits beside the chat. The caller passes its own maximize setter
 * because the chat view's toggle reads `canMaximizeRightPanel` from the render
 * before this click, when the panel may still be closed. Where the panel is a
 * sheet it already covers the chat; the maximize takes effect if the window
 * widens to the inline layout.
 */
export function openFactoryPlanInRightPanel(
  input: FactoryOpenTarget & {
    /** The `factory.plan` activity id. */
    planId: string;
  },
): void {
  openFactoryInRightPanel(input, { tab: "plan", planId: input.planId });
}

/** The run card's Open: that run on the Factory surface's Run tab, opened the way the plan card's Open is. */
export function openFactoryRunInRightPanel(
  input: FactoryOpenTarget & {
    /** The run directory's name. */
    runId: string;
  },
): void {
  openFactoryInRightPanel(input, { tab: "run", planId: null, runId: input.runId });
}

/** The report card's Open: that run's report on the Report tab, opened the way the plan card's Open is. */
export function openFactoryReportInRightPanel(
  input: FactoryOpenTarget & {
    /** The run directory's name. */
    runId: string;
  },
): void {
  openFactoryInRightPanel(input, { tab: "report", planId: null, runId: input.runId });
}
