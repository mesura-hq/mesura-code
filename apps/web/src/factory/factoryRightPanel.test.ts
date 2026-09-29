/**
 * Phase 2 fence, acceptance criterion 3: Open shows the plan in the Factory
 * surface of the right panel, maximized; the surface never opens by itself.
 *
 * Entry point: the card's Open callback in `ChatView`, which is
 * `openFactoryPlanInRightPanel` with ChatView's own maximize setter, acting
 * on the real `useRightPanelStore`. What only a browser shows: the pane
 * filling the chat area while maximized, and the panel's existing Restore
 * control (`toggleRightPanelMaximized`) returning it to side width.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesWithState, deriveWorkLogEntries } from "../session-logic";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { makeFactoryPlanActivity } from "@t3tools/client-runtime/factory/testing";
import { openFactoryPlanInRightPanel } from "./factoryRightPanel";
import { deriveFactoryPlanTimelineItems } from "@t3tools/client-runtime/factory/plan-activities";

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
    const activities = [makeFactoryPlanActivity({ createdAt: "2026-09-28T10:00:05.000Z" })];
    deriveTimelineEntriesWithState(
      [],
      [],
      deriveWorkLogEntries(activities),
      null,
      deriveFactoryPlanTimelineItems(activities),
    );
    expect(panelState().isOpen).toBe(false);
    expect(panelState().surfaces).toEqual([]);

    const revisionBeforeOpen = useRightPanelStore.getState().getUserActionRevision(ref);
    openFromCard();
    // A proactive panel requested before the user's Open is refused.
    expect(
      useRightPanelStore
        .getState()
        .openProactive(ref, { id: "diff", kind: "diff" }, revisionBeforeOpen),
    ).toBe(false);
    expect(panelState().activeSurfaceId).toBe("factory");
  });
});
