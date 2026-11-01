/**
 * Mesura: an agent asks the operator to take over one of its server browser
 * tabs, for a login, a check or a payment step, and waits for the answer. The
 * card is a `browser_takeover_request` turn item, recorded like a secret card.
 */
import {
  BrowserTakeoverError,
  type BrowserTakeoverAnswerInput,
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2BrowserTakeoverRequestStatus,
  type PreviewAutomationStatus,
  type PreviewTabId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

export const BROWSER_TAKEOVER_DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
export const BROWSER_TAKEOVER_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const ANSWER_POLL_INTERVAL_MS = 500;
const STATUS_TIMEOUT_MS = 2_000;

type TakeoverOutcome = Exclude<OrchestrationV2BrowserTakeoverRequestStatus, "pending">;

export interface BrowserTakeoverResult {
  readonly status: TakeoverOutcome;
  /** Read after the outcome: refs from before are stale once a human held the tab. */
  readonly preview: PreviewAutomationStatus | null;
}

export class BrowserTakeoverRequests extends Context.Service<
  BrowserTakeoverRequests,
  {
    readonly request: (input: {
      readonly scope: McpThreadInvocationScope;
      readonly tabId?: PreviewTabId | undefined;
      readonly reason: string;
      readonly timeoutMs?: number | undefined;
    }) => Effect.Effect<BrowserTakeoverResult, OrchestratorMcpFailure>;
    readonly answer: (
      input: BrowserTakeoverAnswerInput,
    ) => Effect.Effect<void, BrowserTakeoverError>;
  }
>()("t3/preview/BrowserTakeoverRequests") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const make = Effect.gen(function* () {
  // Optional so every MCP host can carry the tool; only a server with a browser can answer it.
  const browser = yield* Effect.serviceOption(ServerBrowser.ServerBrowser);
  const crypto = yield* Crypto.Crypto;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const readCard = (threadId: McpThreadInvocationScope["thread"]["threadId"]) =>
    threadManagement.getThreadRecords(threadId, ["runs", "turnItems"], {
      turnItemTypes: ["browser_takeover_request"],
      messageRoles: [],
    });

  const request: BrowserTakeoverRequests["Service"]["request"] = Effect.fn(
    "BrowserTakeoverRequests.request",
  )(function* ({ scope, tabId, reason, timeoutMs }) {
    const threadId = scope.thread.threadId;
    const records = yield* readCard(threadId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read the thread: ${error.message}`),
      ),
    );
    const run = ThreadManagementService.latestActiveRun(records);
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== scope.thread.providerInstanceId
    ) {
      return yield* failure(
        "parent_not_active",
        "Asking the operator to take over requires an active run owned by this MCP provider session.",
      );
    }
    const runId = run.id;
    const nodeId = run.rootNodeId;
    if (Option.isNone(browser)) {
      return yield* failure(
        "provider_unavailable",
        "This environment has no server browser, so no tab can be taken over.",
      );
    }
    const prepared = yield* browser.value
      .prepareTakeover({
        threadId,
        agentSessionId: PreviewAutomationBroker.hostAssignmentKey(scope),
        tabId,
      })
      .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
    const turnItemId = TurnItemId.make(
      `turn-item:browser-takeover:${threadId}:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );
    const record = (takeoverStatus: OrchestrationV2BrowserTakeoverRequestStatus) =>
      threadManagement
        .dispatch({
          type: "browser_takeover_request.record",
          commandId: CommandId.make(`${turnItemId}:${takeoverStatus}`),
          threadId,
          runId,
          nodeId,
          turnItemId,
          tabId: prepared.tabId,
          reason,
          takeoverStatus,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Could not record the takeover request: ${error.message}`,
            ),
          ),
        );
    yield* record("pending");
    // Only this call waits on the card, so the card must not outlive it.
    const closeCard = record("cancelled").pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not close a browser takeover card", { error: error.message }),
      ),
    );

    const cardAnswer = Effect.gen(function* () {
      while (true) {
        const current = yield* readCard(threadId).pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Unable to read the takeover request: ${error.message}`),
          ),
        );
        const item = current.turnItems.find((candidate) => candidate.id === turnItemId);
        if (item?.type === "browser_takeover_request" && item.takeoverStatus !== "pending") {
          return item.takeoverStatus;
        }
        const currentRun = current.runs.find((candidate) => candidate.id === runId);
        if (
          currentRun === undefined ||
          ThreadManagementService.isTerminalRunStatus(currentRun.status)
        ) {
          yield* record("cancelled");
          return "cancelled" as const;
        }
        yield* Effect.sleep(Duration.millis(ANSWER_POLL_INTERVAL_MS));
      }
    });
    const humanCycle = prepared.humanControlCycle.pipe(
      Effect.andThen(record("done")),
      Effect.as("done" as const),
    );

    const answered = yield* Effect.raceFirst(cardAnswer, humanCycle).pipe(
      Effect.timeoutOption(
        Duration.millis(
          Math.min(
            timeoutMs ?? BROWSER_TAKEOVER_DEFAULT_TIMEOUT_MS,
            BROWSER_TAKEOVER_MAX_TIMEOUT_MS,
          ),
        ),
      ),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
    );
    if (Option.isNone(answered)) yield* closeCard;
    const proposed: TakeoverOutcome = Option.isSome(answered) ? answered.value : "cancelled";
    // The card keeps its first answer, which may be the operator's rather than this call's.
    const status = yield* readCard(threadId).pipe(
      Effect.map((current) => {
        const item = current.turnItems.find((candidate) => candidate.id === turnItemId);
        return item?.type === "browser_takeover_request" && item.takeoverStatus !== "pending"
          ? item.takeoverStatus
          : proposed;
      }),
      Effect.orElseSucceed(() => proposed),
    );
    yield* Effect.annotateCurrentSpan({ "browser_takeover.status": status });
    const preview = yield* broker
      .invoke<PreviewAutomationStatus>({
        scope,
        tabId: prepared.tabId,
        operation: "status",
        input: {},
        timeoutMs: STATUS_TIMEOUT_MS,
        updateCurrentTab: false,
      })
      .pipe(Effect.orElseSucceed(() => null));
    return { status, preview };
  }, Effect.scoped);

  const answer: BrowserTakeoverRequests["Service"]["answer"] = Effect.fn(
    "BrowserTakeoverRequests.answer",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["runs", "turnItems"], {
        turnItemTypes: ["browser_takeover_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new BrowserTakeoverError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    if (item?.type !== "browser_takeover_request" || item.runId === null || item.nodeId === null) {
      return yield* new BrowserTakeoverError({ reason: "not_found" });
    }
    if (item.takeoverStatus !== "pending") {
      return yield* new BrowserTakeoverError({ reason: "already_answered" });
    }
    const run = records.runs.find((candidate) => candidate.id === item.runId);
    if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
      return yield* new BrowserTakeoverError({ reason: "agent_stopped" });
    }
    yield* threadManagement
      .dispatch({
        type: "browser_takeover_request.record",
        commandId: CommandId.make(`${item.id}:answer:${input.answer}`),
        threadId: input.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        turnItemId: item.id,
        tabId: item.tabId,
        reason: item.reason,
        takeoverStatus: input.answer,
      })
      .pipe(
        Effect.mapError((cause) => new BrowserTakeoverError({ reason: "record_failed", cause })),
      );
  });

  return BrowserTakeoverRequests.of({ request, answer });
});

export const layer = Layer.effect(BrowserTakeoverRequests, make);
