// Entry point: `BrowserTakeoverRequests.answer`, the service method behind the
// `preview.answerTakeoverRequest` RPC. The thread service is a fake that holds one
// run and one card and records what is dispatched; the browser is never reached.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type BrowserTakeoverAnswerInput,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BrowserTakeoverRequests from "./BrowserTakeoverRequests.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const NOW = DateTime.makeUnsafe("2026-11-01T12:00:00.000Z");
const THREAD_ID = ThreadId.make("thread:takeover-answer");
const RUN_ID = RunId.make("run:takeover-answer");
const NODE_ID = NodeId.make("node:takeover-answer");
const CARD_ID = TurnItemId.make("turn-item:takeover-answer");
const codex = ProviderInstanceId.make("codex");

const run = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: RUN_ID,
  threadId: THREAD_ID,
  ordinal: 1,
  providerInstanceId: codex,
  modelSelection: { instanceId: codex, model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message:takeover-answer"),
  rootNodeId: NODE_ID,
  activeAttemptId: null,
  status,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: status === "running" ? null : NOW,
  checkpointId: null,
  contextHandoffId: null,
});

const card = (
  takeoverStatus: "pending" | "done" | "declined" | "cancelled",
): OrchestrationV2TurnItem => ({
  id: CARD_ID,
  threadId: THREAD_ID,
  runId: RUN_ID,
  nodeId: NODE_ID,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: takeoverStatus === "pending" ? "waiting" : "completed",
  title: null,
  startedAt: NOW,
  completedAt: takeoverStatus === "pending" ? null : NOW,
  updatedAt: NOW,
  type: "browser_takeover_request",
  tabId: "tab-login",
  reason: "The bank asks for a 2FA code",
  takeoverStatus,
});

const answerWith = (
  records: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  },
  answer: BrowserTakeoverAnswerInput["answer"],
) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const takeovers = yield* BrowserTakeoverRequests.BrowserTakeoverRequests.pipe(
      Effect.provide(
        BrowserTakeoverRequests.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              Layer.mock(ServerBrowser.ServerBrowser)({}),
              Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadRecords: (() => Effect.succeed(records)) as never,
                dispatch: (command) =>
                  Effect.sync(() => {
                    dispatched.push(command);
                    return {} as never;
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    const result = yield* takeovers
      .answer({ threadId: THREAD_ID, turnItemId: CARD_ID, answer })
      .pipe(Effect.result);
    return { result, dispatched };
  });

it.effect.each(["done", "declined"] as const)(
  "takeover answer service: a %s answer on a pending card of a live run re-records the card with that status",
  (answer) =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* answerWith(
        { runs: [run("running")], turnItems: [card("pending")] },
        answer,
      );
      assert.equal(result._tag, "Success");
      assert.deepEqual(
        dispatched.map((command) => ({ ...command, commandId: undefined })),
        [
          {
            type: "browser_takeover_request.record",
            commandId: undefined,
            threadId: THREAD_ID,
            runId: RUN_ID,
            nodeId: NODE_ID,
            turnItemId: CARD_ID,
            tabId: "tab-login",
            reason: "The bank asks for a 2FA code",
            takeoverStatus: answer,
          },
        ] as never,
      );
    }),
);

it.effect.each([
  { name: "an answered card", runStatus: "running", status: "done", reason: "already_answered" },
  {
    name: "a card whose run ended",
    runStatus: "completed",
    status: "pending",
    reason: "agent_stopped",
  },
  { name: "a missing card", runStatus: "running", status: undefined, reason: "not_found" },
] as const)(
  "takeover answer service: answering $name fails with $reason and records nothing",
  ({ runStatus, status, reason }) =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* answerWith(
        { runs: [run(runStatus)], turnItems: status === undefined ? [] : [card(status)] },
        "done",
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, reason);
      assert.deepEqual(dispatched, []);
    }),
);
