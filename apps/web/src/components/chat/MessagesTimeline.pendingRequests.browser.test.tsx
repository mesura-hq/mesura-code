/**
 * Entry point: the real `MessagesTimeline`, fed rows from `deriveTimelineEntriesFromVisibleTurnItems`,
 * with an agent's link request followed by the agent's later reply.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { appRootFence, makeFenceSession } from "../../test/appRootFenceMocks";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import { MessagesTimeline } from "./MessagesTimeline";

vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await import("../../test/appRootFenceMocks")).mockRuntimeSession(original),
);
vi.mock("~/connection/runtime", async () =>
  (await import("../../test/appRootFenceMocks")).mockConnectionRuntime(),
);

// The session's permissions are read once per environment, so each permission set has its own.
const ACCESS_ENVIRONMENT_ID = EnvironmentId.make("environment-manages-access");
const NO_ACCESS_ENVIRONMENT_ID = EnvironmentId.make("environment-without-access");
const LINK_REASON = "Install and verify the corrected release on your PC after the PR merges.";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type ProjectedItem = ReturnType<typeof makeStreamingTimelineFixture>["visibleTurnItems"][number];

/** The user's message, the agent's link request, then the agent's reply that came after it. */
function linkRequestThenReply(): ReadonlyArray<ProjectedItem> {
  const [userMessage, , reply] = makeStreamingTimelineFixture().visibleTurnItems;
  const linkRequest = {
    ...reply!,
    sourceItemId: TurnItemId.make("link-request"),
    item: {
      ...reply!.item,
      id: TurnItemId.make("link-request"),
      type: "link_request",
      reason: LINK_REASON,
      linkStatus: "pending",
    },
  } as ProjectedItem;
  return [userMessage!, linkRequest, reply!].map((projected, position) => ({
    ...projected,
    position,
  }));
}

async function renderTimeline(environmentId: EnvironmentId) {
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("link-request-thread"));
  const props: TimelineProps = {
    timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: linkRequestThenReply(),
      optimisticMessages: [],
    }),
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: scopedThreadKey(threadRef),
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: environmentId,
    markdownCwd: undefined,
    resolvedTheme: "dark",
    timestampFormat: "24-hour",
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
  container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(<MessagesTimeline {...props} />, { container });
  return Object.assign(screen, { container });
}

it("pending requests: a link request waits after the agent's later reply", async () => {
  appRootFence.sessions.set(
    ACCESS_ENVIRONMENT_ID,
    makeFenceSession([AuthOrchestrationOperateScope, AuthAccessWriteScope]),
  );
  await using screen = await renderTimeline(ACCESS_ENVIRONMENT_ID);

  await expect.element(screen.getByText(LINK_REASON)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Choose machine…" })).toBeVisible();
  const card = screen.container.querySelector('[data-v2-item-type="link_request"]')!;
  const reply = screen.getByText("Done").element();
  expect(
    reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the card renders after the reply",
  ).toBeTruthy();
});

it("pending requests: a device without access management is told to pair again", async () => {
  appRootFence.sessions.set(
    NO_ACCESS_ENVIRONMENT_ID,
    makeFenceSession([AuthOrchestrationOperateScope]),
  );
  await using screen = await renderTimeline(NO_ACCESS_ENVIRONMENT_ID);

  await expect.element(screen.getByText(/Pair it again to answer\./)).toBeVisible();
  expect(
    [...screen.container.querySelectorAll('[data-v2-item-type="link_request"] button')].map(
      (button) => button.textContent,
    ),
  ).toEqual([]);
});
