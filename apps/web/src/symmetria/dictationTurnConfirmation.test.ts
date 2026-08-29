import {
  SymmetriaDictationSessionId,
  type SymmetriaDictationTarget,
} from "@symmetria/broker-contract";
import { CommandId, EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "vite-plus/test";

import { waitForDictationTurn } from "./dictationTurnConfirmation";

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");
const messageId = MessageId.make("message-a");
const target: SymmetriaDictationTarget = { kind: "thread", environmentId, threadId };
const identity = {
  protocolVersion: { major: 1 as const, minor: 3 },
  sessionId: SymmetriaDictationSessionId.make("session-a"),
  commandId: CommandId.make("command-a"),
  target,
};

it("confirms only the running turn correlated with the exact user message", async () => {
  const receipt = await waitForDictationTurn({
    ...identity,
    environmentId,
    threadId,
    messageId,
    read: () => ({
      turnId: TurnId.make("turn-a"),
      state: "running",
      userMessageId: messageId,
    }),
    subscribe: () => () => undefined,
    deadline: new Promise<never>(() => undefined),
  });

  assert.deepInclude(receipt, {
    outcome: "turn-running",
    messageId,
    turnId: TurnId.make("turn-a"),
  });
});

it("cannot lose a running update between subscribing and reading", async () => {
  let current: ReturnType<Parameters<typeof waitForDictationTurn>[0]["read"]> = null;
  const receipt = await waitForDictationTurn({
    ...identity,
    environmentId,
    threadId,
    messageId,
    read: () => current,
    subscribe: () => {
      current = {
        turnId: TurnId.make("turn-race"),
        state: "running",
        userMessageId: messageId,
      };
      return () => undefined;
    },
    deadline: new Promise<never>(() => undefined),
  });

  assert.equal(receipt.outcome, "turn-running");
  if (receipt.outcome !== "turn-running") return;
  assert.equal(receipt.turnId, "turn-race");
});

it("reports provider failure for the correlated errored turn", async () => {
  const receipt = await waitForDictationTurn({
    ...identity,
    environmentId,
    threadId,
    messageId,
    read: () => ({
      turnId: TurnId.make("turn-a"),
      state: "error",
      userMessageId: messageId,
    }),
    subscribe: () => () => undefined,
    deadline: new Promise<never>(() => undefined),
  });

  assert.deepInclude(receipt, {
    outcome: "failed",
    code: "provider_start_failed",
  });
});

it("returns confirmation-pending at the deadline and keeps the watcher alive", async () => {
  let unsubscribeCount = 0;
  const receipt = await waitForDictationTurn({
    ...identity,
    environmentId,
    threadId,
    messageId,
    read: () => null,
    subscribe: () => () => {
      unsubscribeCount += 1;
    },
    deadline: Promise.resolve(),
    keepWatchingAfterDeadline: true,
  });

  assert.equal(receipt.outcome, "confirmation-pending");
  assert.equal(unsubscribeCount, 0);
});
