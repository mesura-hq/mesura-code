/**
 * Entry point: the real `MessagesTimeline`, fed rows from `deriveTimelineEntriesFromVisibleTurnItems`.
 * The route thread key scopes the preview state; the session source is the app-root fence's.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { appRootFence, makeFenceSession } from "../../test/appRootFenceMocks";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "../../previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import { MessagesTimeline } from "./MessagesTimeline";

vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await import("../../test/appRootFenceMocks")).mockRuntimeSession(original),
);
vi.mock("~/connection/runtime", async () =>
  (await import("../../test/appRootFenceMocks")).mockConnectionRuntime(),
);

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const TAKEOVER_REASON = "The bank asks for a 2FA code before it shows the statement";
const LOGIN_TAB_ID = "tab-login";
const OTHER_TAB_ID = "tab-docs";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type ProjectedItem = ReturnType<typeof makeStreamingTimelineFixture>["visibleTurnItems"][number];

const previewSnapshot = (tabId: string, second: number) => ({
  threadId: "takeover-thread",
  tabId,
  navStatus: { _tag: "Idle" as const },
  canGoBack: false,
  canGoForward: false,
  updatedAt: `2026-11-01T00:00:0${second}.000Z`,
});

/** One projected card, built on the fixture's assistant row so every shared field is real. */
function projectedCard(fields: Record<string, unknown>): ProjectedItem {
  const assistant = makeStreamingTimelineFixture().visibleTurnItems[5]!;
  return {
    ...assistant,
    item: { ...assistant.item, status: "waiting", completedAt: null, ...fields },
  } as ProjectedItem;
}

async function renderTimeline(cards: ReadonlyArray<ProjectedItem>) {
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("takeover-thread"));
  const props: TimelineProps = {
    timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: cards,
      optimisticMessages: [],
    }),
    isWorking: true,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: scopedThreadKey(threadRef),
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(<MessagesTimeline {...props} />, { container });
  return Object.assign(screen, { threadRef, container });
}

it("takeover phase AC7: the timeline shows a pending takeover card with the agent's reason and a button that opens the tab", async () => {
  resetPreviewStateForTests();
  appRootFence.sessions.set(ENVIRONMENT_ID, makeFenceSession([AuthOrchestrationOperateScope]));
  await using screen = await renderTimeline([
    projectedCard({
      type: "browser_takeover_request",
      tabId: LOGIN_TAB_ID,
      reason: TAKEOVER_REASON,
      takeoverStatus: "pending",
    }),
  ]);
  applyPreviewServerSnapshot(screen.threadRef, previewSnapshot(LOGIN_TAB_ID, 1));
  applyPreviewServerSnapshot(screen.threadRef, previewSnapshot(OTHER_TAB_ID, 2));
  expect(readThreadPreviewState(screen.threadRef).activeTabId).toBe(OTHER_TAB_ID);

  const card = screen.container.querySelector<HTMLElement>(
    '[data-v2-item-type="browser_takeover_request"]',
  );
  expect(card, "the timeline mounts a takeover card").not.toBeNull();
  await expect.element(screen.getByText(TAKEOVER_REASON)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^done$/i })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^cannot/i })).toBeVisible();

  const openTab = screen.getByRole("button", { name: /open tab/i });
  await expect.element(openTab).toBeVisible();
  await openTab.click();
  expect(readThreadPreviewState(screen.threadRef).activeTabId).toBe(LOGIN_TAB_ID);
});

it("takeover guard: the timeline still renders a pending link_request card with its reason", async () => {
  resetPreviewStateForTests();
  await using screen = await renderTimeline([
    projectedCard({
      type: "link_request",
      reason: "Link the laptop so I can run the build there",
      linkStatus: "pending",
    }),
  ]);
  expect(
    screen.container.querySelector('[data-v2-item-type="link_request"]'),
    "the timeline mounts a link card",
  ).not.toBeNull();
  await expect.element(screen.getByText("Link a machine to this environment")).toBeVisible();
  await expect
    .element(screen.getByText("Link the laptop so I can run the build there"))
    .toBeVisible();
});

it("takeover rework: Open tab on a takeover card shows that tab when the panel shows another surface", async () => {
  resetPreviewStateForTests();
  appRootFence.sessions.set(ENVIRONMENT_ID, makeFenceSession([AuthOrchestrationOperateScope]));
  await using screen = await renderTimeline([
    projectedCard({
      type: "browser_takeover_request",
      tabId: LOGIN_TAB_ID,
      reason: TAKEOVER_REASON,
      takeoverStatus: "pending",
    }),
  ]);
  applyPreviewServerSnapshot(screen.threadRef, previewSnapshot(LOGIN_TAB_ID, 1));
  useRightPanelStore.getState().openTerminal(screen.threadRef, "terminal-1");
  const activeSurface = () =>
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, screen.threadRef);
  expect(activeSurface()?.kind).toBe("terminal");

  await screen.getByRole("button", { name: /open tab/i }).click();
  expect(activeSurface()).toMatchObject({ kind: "preview", resourceId: LOGIN_TAB_ID });
  expect(readThreadPreviewState(screen.threadRef).activeTabId).toBe(LOGIN_TAB_ID);
});
