import { RunId } from "@t3tools/contracts";
/**
 * Open shows the plan in the right panel's Factory surface, maximized, through
 * `openFactoryPlanInRightPanel` on the real `useRightPanelStore`; the surface never opens by
 * itself. The maximized pane's layout and the Restore control are left to a real browser.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../session-logic";
import { projectFactoryTurnItems } from "./factoryTestFixtures";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import {
  makeFactoryCardTurnItem,
  makeFactoryPlanPayload,
} from "@t3tools/client-runtime/factory/testing";
import { openFactoryPlanInRightPanel } from "./factoryRightPanel";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("factory-thread"));
const planId = "factory-plan:plan-md";

const panelState = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

function openFromCard() {
  const maximized: Array<string | null> = [];
  openFactoryPlanInRightPanel({
    ref,
    planId,
    maximizeKey: scopedThreadKey(ref),
    setMaximizedRightPanelThreadKey: (key) => maximized.push(key),
  });
  return maximized;
}

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

describe("factory surface in the right panel (phase 2 fence)", () => {
  it("opens a factory plan in the Factory surface, maximized beside the chat", () => {
    const maximized = openFromCard();

    expect(panelState()).toMatchObject({
      isOpen: true,
      activeSurfaceId: "factory",
      surfaces: [{ id: "factory", kind: "factory", tab: "plan", planId, runId: null }],
    });
    expect(maximized).toEqual([scopedThreadKey(ref)]);
  });

  it("sets the maximize on every Open, never toggling it off", () => {
    // Where the panel is a sheet ChatView ignores the key; it takes effect when
    // the window widens (phase 9 verify ①). A second Open keeps it set.
    expect(openFromCard()).toEqual([scopedThreadKey(ref)]);
    expect(openFromCard()).toEqual([scopedThreadKey(ref)]);
    expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: "factory" });
  });

  it("keeps one Factory surface and switches it to the plan opened last", () => {
    const store = useRightPanelStore.getState();
    store.open(ref, "diff");
    store.openFactory(ref, { tab: "plan", planId: "factory-plan:first" });
    store.activateSurface(ref, "diff");
    store.openFactory(ref, { tab: "plan", planId });

    const state = panelState();
    expect(state.surfaces.filter((surface) => surface.kind === "factory")).toEqual([
      { id: "factory", kind: "factory", tab: "plan", planId, runId: null },
    ]);
    expect(state.activeSurfaceId).toBe("factory");
  });

  it("never opens the Factory surface when a plan is presented, and counts Open as the user's choice", () => {
    const items = [
      makeFactoryCardTurnItem({
        id: planId,
        threadId: ref.threadId,
        createdAt: "2026-09-28T10:00:05.000Z",
        card: { kind: "plan", payload: makeFactoryPlanPayload() },
      }),
    ];
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: projectFactoryTurnItems(items),
      optimisticMessages: [],
    });
    expect(panelState().isOpen).toBe(false);
    expect(panelState().surfaces).toEqual([]);

    const revisionBeforeOpen = useRightPanelStore.getState().getUserActionRevision(ref);
    openFromCard();
    // A proactive panel requested before the user's Open is refused.
    expect(
      useRightPanelStore
        .getState()
        .openProactive(
          ref,
          { kind: "diff", turnId: RunId.make("automatic-diff") },
          revisionBeforeOpen,
        ),
    ).toBe(false);
    expect(panelState().activeSurfaceId).toBe("factory");
  });
});
