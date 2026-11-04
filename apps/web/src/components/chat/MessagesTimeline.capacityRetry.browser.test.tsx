/**
 * Entry point: the real `MessagesTimeline`, fed rows from `deriveTimelineEntriesFromVisibleTurnItems`,
 * with a Codex capacity retry as the running turn's live entry.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import { createRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { appRootFence, makeFenceSession } from "../../test/appRootFenceMocks";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import { MessagesTimeline } from "./MessagesTimeline";

const fence = { commandCalls: [] as Array<unknown> };
/** Resets what the `use-atom-command` mock records. */
function setup() {
  fence.commandCalls.length = 0;
}
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await import("../../test/appRootFenceMocks")).mockRuntimeSession(original),
);
vi.mock("~/connection/runtime", async () =>
  (await import("../../test/appRootFenceMocks")).mockConnectionRuntime(),
);
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (request: unknown) => {
    fence.commandCalls.push(request);
    return { _tag: "Success", value: { retried: true } };
  },
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
// The session's permissions are read once per environment, so the read-only client has its own.
const READ_ONLY_ENVIRONMENT_ID = EnvironmentId.make("environment-read-only");
const THREAD_ID = ThreadId.make("capacity-thread");
const PROVIDER_THREAD_ID = ProviderThreadId.make("capacity-provider-thread");
const PROVIDER_TURN_ID = ProviderTurnId.make("capacity-provider-turn");
/** Five seconds into the wait. */
const NOW_MS =
  DateTime.toEpochMillis(makeStreamingTimelineFixture().visibleTurnItems[4]!.item.updatedAt) +
  5_000;

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type ProjectedItem = ReturnType<typeof makeStreamingTimelineFixture>["visibleTurnItems"][number];

/**
 * The live run's user message, optionally a finished tool call, then a capacity retry whose
 * 40-second wait started at the fixture's time.
 */
function waitingCapacityRetry(
  options: { precedingWork?: boolean } = {},
): ReadonlyArray<ProjectedItem> {
  const fixture = makeStreamingTimelineFixture().visibleTurnItems;
  const work = fixture[4]!;
  const updatedAt = work.item.updatedAt;
  const retry = {
    ...work,
    position: work.position + 1,
    sourceItemId: TurnItemId.make("capacity-retry-item"),
    item: {
      ...work.item,
      id: TurnItemId.make("capacity-retry-item"),
      ordinal: work.item.ordinal + 1,
      threadId: THREAD_ID,
      providerThreadId: PROVIDER_THREAD_ID,
      providerTurnId: PROVIDER_TURN_ID,
      type: "error",
      status: "running",
      title: "Provider retry",
      startedAt: updatedAt,
      completedAt: null,
      updatedAt,
      failure: {
        class: "provider_error",
        message: "Selected model is at capacity. Please try a different model.",
        code: "serverOverloaded",
        retryable: true,
      },
      retry: { attempt: 3, maxAttempts: 10, retryDelayMs: 40_000 },
    },
  } as ProjectedItem;
  return options.precedingWork ? [fixture[3]!, work, retry] : [fixture[3]!, retry];
}

async function renderTimeline(
  items: ReadonlyArray<ProjectedItem>,
  environmentId: EnvironmentId = ENVIRONMENT_ID,
) {
  const threadRef = scopeThreadRef(environmentId, THREAD_ID);
  const props: TimelineProps = {
    timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items,
      optimisticMessages: [],
    }),
    isWorking: true,
    activeTurnInProgress: true,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    runningRunId: makeStreamingTimelineFixture().runId,
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

it("capacity retry: the waiting row counts down, shows the schedule, and Retry now asks for this turn", async () => {
  setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  appRootFence.sessions.set(ENVIRONMENT_ID, makeFenceSession([AuthOrchestrationOperateScope]));
  await using screen = await renderTimeline(waitingCapacityRetry());

  const row = screen.container.querySelector<HTMLElement>('[data-capacity-retry="running"]');
  expect(row, "the live entry is the capacity row").not.toBeNull();
  await expect.element(screen.getByText("Model at capacity")).toBeVisible();
  await vi.waitFor(() => expect(row!.textContent).toMatch(/Retry 3\/10 at \d\d:\d\d · in 0:35/));
  expect(
    [...row!.querySelectorAll("[data-capacity-retry-step]")].map(
      (step) => `${step.textContent}:${step.getAttribute("data-capacity-retry-step")}`,
    ),
  ).toEqual([
    "10s:done",
    "20s:done",
    "40s:current",
    "1m:pending",
    "2m:pending",
    "5m:pending",
    "10m:pending",
    "20m:pending",
    "40m:pending",
    "60m:pending",
  ]);

  await screen.getByRole("button", { name: "Retry now" }).click();
  expect(fence.commandCalls).toEqual([
    {
      environmentId: ENVIRONMENT_ID,
      input: {
        threadId: THREAD_ID,
        providerThreadId: PROVIDER_THREAD_ID,
        providerTurnId: PROVIDER_TURN_ID,
      },
    },
  ]);
  await expect.element(screen.getByText(/Retry 3\/10 starting…/)).toBeVisible();
  expect(
    [...row!.querySelectorAll("button")].some((button) => button.textContent === "Retry now"),
    "one request per attempt",
  ).toBe(false);
});

it("capacity retry: a client that may only read sees the countdown without Retry now", async () => {
  setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  appRootFence.sessions.set(
    READ_ONLY_ENVIRONMENT_ID,
    makeFenceSession([AuthOrchestrationReadScope]),
  );
  await using screen = await renderTimeline(waitingCapacityRetry(), READ_ONLY_ENVIRONMENT_ID);
  await expect.element(screen.getByText("Model at capacity")).toBeVisible();
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-capacity-retry="running"]')!.textContent).toMatch(
      /in 0:35/,
    ),
  );
  expect(
    [...screen.container.querySelectorAll('[data-capacity-retry="running"] button')].some(
      (button) => button.textContent === "Retry now",
    ),
  ).toBe(false);
});

it("capacity retry: the work group stays reachable from the waiting row", async () => {
  setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  appRootFence.sessions.set(ENVIRONMENT_ID, makeFenceSession([AuthOrchestrationOperateScope]));
  await using screen = await renderTimeline(waitingCapacityRetry({ precedingWork: true }));

  await expect.element(screen.getByText("Model at capacity")).toBeVisible();
  const row = screen.container.querySelector<HTMLElement>('[data-capacity-retry="running"]')!;
  const disclosure = row.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(disclosure, "the live row keeps its group disclosure").not.toBeNull();
  expect(disclosure!.getAttribute("aria-expanded")).toBe("false");
  expect(disclosure!.textContent, "Retry now sits beside the disclosure").not.toContain(
    "Retry now",
  );

  disclosure!.click();
  await vi.waitFor(() => expect(screen.container.textContent).toMatch(/index\.ts/));
  const reopened = screen.container.querySelector<HTMLButtonElement>(
    '[data-capacity-retry="running"] button[aria-expanded]',
  )!;
  expect(reopened.getAttribute("aria-expanded")).toBe("true");
  reopened.click();
  await vi.waitFor(() =>
    expect(
      screen.container
        .querySelector('[data-capacity-retry="running"] button[aria-expanded]')!
        .getAttribute("aria-expanded"),
    ).toBe("false"),
  );
});

it("capacity retry: a device clock past the deadline still offers Retry now", async () => {
  setup();
  // Ten minutes ahead of the server: the wait looks over here while the server still waits.
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW_MS + 600_000);
  appRootFence.sessions.set(ENVIRONMENT_ID, makeFenceSession([AuthOrchestrationOperateScope]));
  await using screen = await renderTimeline(waitingCapacityRetry());

  await expect.element(screen.getByText(/Retry 3\/10 due now/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry now" })).toBeVisible();
});
