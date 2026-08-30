import {
  SymmetriaDictationCommand,
  SymmetriaDictationReceipt,
  SymmetriaDictationTarget,
} from "@symmetria/broker-contract";
import { CommandId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import {
  createDictationBroker,
  createRendererRequestBridge,
  isolateDictationBrokerStartup,
} from "./DictationBroker.ts";
import { sttSocketPath } from "./sttSocketFiles.ts";
import { dictationSocketPath } from "./dictationSocketFiles.ts";
import { parseDictationClientLine } from "./dictationProtocol.ts";

const decodeTarget = Schema.decodeUnknownSync(SymmetriaDictationTarget);
const decodeCommand = Schema.decodeUnknownSync(SymmetriaDictationCommand);
const decodeReceipt = Schema.decodeUnknownSync(SymmetriaDictationReceipt);

const targetA = decodeTarget({
  kind: "thread",
  environmentId: "environment-a",
  threadId: "thread-a",
});
const targetB = decodeTarget({
  kind: "thread",
  environmentId: "environment-b",
  threadId: "thread-b",
});

const makeReserveRequest = (sessionId = "session-a", commandId = "command-reserve") => {
  const parsed = parseDictationClientLine(
    JSON.stringify({
      type: "dictation.reserve.request",
      protocolVersion: { major: 1, minor: 2 },
      sessionId,
      commandId,
      createdAt: "2026-08-29T12:00:00.000Z",
      source: "shell",
    }),
  );
  if (!parsed.ok || parsed.message.type !== "dictation.reserve.request") {
    throw new Error("invalid reservation fixture");
  }
  return parsed.message;
};
const reserveRequest = makeReserveRequest();

const makeDeliverCommand = (commandId = "command-deliver") =>
  decodeCommand({
    type: "dictation.deliver",
    protocolVersion: { major: 1, minor: 2 },
    sessionId: "session-a",
    commandId,
    createdAt: "2026-08-29T12:00:02.000Z",
    target: targetA,
    mode: "submit",
    text: "dictated words",
  });

const makeTurnRunningReceipt = () =>
  decodeReceipt({
    outcome: "turn-running",
    protocolVersion: { major: 1, minor: 2 },
    sessionId: "session-a",
    commandId: "command-deliver",
    target: targetA,
    application: "first",
    messageId: "message-a",
    turnId: "turn-a",
  });

// Acceptance: Shell does not start audio until the renderer supplies and the
// broker records an immutable target.
it("reserves a renderer-supplied target before returning the session to Shell", async () => {
  const calls: Array<string> = [];
  const broker = createDictationBroker({
    reserveTarget: async () => {
      calls.push("renderer-reserved");
      return { target: targetA, projectName: "Project A" };
    },
    deliver: async () => makeTurnRunningReceipt(),
  });

  const session = await broker.reserve(reserveRequest);
  calls.push("shell-received");

  assert.deepEqual(calls, ["renderer-reserved", "shell-received"]);
  assert.deepEqual(session.target, targetA);
  assert.deepEqual(broker.snapshot()?.target, targetA);
});

it("refuses a Mesura microphone reservation when no Shell client is connected", async () => {
  const broker = createDictationBroker({
    isShellAvailable: () => false,
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => makeTurnRunningReceipt(),
  });

  const error = await broker
    .reserve({ ...reserveRequest, source: "mesura" })
    .then(() => null)
    .catch((cause: unknown) => cause);

  assert.instanceOf(error, Error);
  assert.include((error as Error).message, "Shell dictation is unavailable");
  assert.isNull(broker.snapshot());
});

// Acceptance: delivery uses the reservation, even when the displayed route has
// changed while transcription runs.
it("delivers only to the reserved target and never asks for the current target", async () => {
  let currentTarget = targetA;
  const deliveredTargets: Array<unknown> = [];
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async (_command, reservedTarget) => {
      deliveredTargets.push(reservedTarget);
      return makeTurnRunningReceipt();
    },
  });

  await broker.reserve(reserveRequest);
  currentTarget = targetB;
  await broker.command(makeDeliverCommand());

  assert.deepEqual(currentTarget, targetB);
  assert.deepEqual(deliveredTargets, [targetA]);
});

// Acceptance: a replay can recover the recorded result, but cannot repeat the
// composer or turn-start side effect.
it("replays a duplicate command receipt without applying delivery twice", async () => {
  let deliveryCount = 0;
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => {
      deliveryCount += 1;
      return makeTurnRunningReceipt();
    },
  });
  await broker.reserve(reserveRequest);

  const first = await broker.command(makeDeliverCommand());
  const replay = await broker.command(makeDeliverCommand());

  assert.equal(deliveryCount, 1);
  assert.equal(first?.application, "first");
  assert.equal(replay?.application, "replay");
  assert.deepEqual(replay === null ? null : { ...replay, application: "first" }, first);
});

// Acceptance: renderer reload starts from the broker's held session rather
// than an empty UI, and the initial snapshot precedes subsequent changes.
it("sends a renderer reconnect the current snapshot before later events", async () => {
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => makeTurnRunningReceipt(),
  });
  await broker.reserve(reserveRequest);

  const observed: Array<string> = [];
  const unsubscribe = broker.subscribe((snapshot) => observed.push(snapshot?.phase ?? "idle"));
  await broker.command(
    decodeCommand({
      type: "dictation.mode.set",
      protocolVersion: { major: 1, minor: 2 },
      sessionId: "session-a",
      commandId: "command-mode",
      createdAt: "2026-08-29T12:00:01.000Z",
      mode: "inject",
    }),
  );
  unsubscribe();

  assert.deepEqual(observed, ["recording", "recording"]);
  assert.equal(broker.snapshot()?.mode, "inject");
});

it("retains exact controls and applies Shell engine progress to the session snapshot", async () => {
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => makeTurnRunningReceipt(),
  });
  await broker.reserve(reserveRequest);

  await broker.command(
    decodeCommand({
      type: "dictation.control",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-restart",
      createdAt: "2026-08-29T12:00:01.000Z",
      action: "restart",
    }),
  );
  assert.deepEqual(broker.snapshot()?.lastControl, {
    commandId: CommandId.make("command-restart"),
    action: "restart",
  });
  await broker.command(
    decodeCommand({
      type: "dictation.state.update",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-progress",
      createdAt: "2026-08-29T12:00:02.000Z",
      phase: "grace",
      elapsedMs: 4200,
      audioLevel: null,
      graceRemainingMs: 2800,
    }),
  );

  assert.equal(broker.snapshot()?.lastControl?.commandId, "command-restart");
  assert.equal(broker.snapshot()?.phase, "grace");
  assert.equal(broker.snapshot()?.elapsedMs, 4200);
  assert.equal(broker.snapshot()?.audioLevel, null);
  assert.equal(broker.snapshot()?.graceRemainingMs, 2800);

  await broker.command(
    decodeCommand({
      type: "dictation.action.acknowledge",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-ack-wrong",
      createdAt: "2026-08-29T12:00:03.000Z",
      actionKind: "control",
      acknowledgedCommandId: "another-control",
    }),
  );
  assert.equal(broker.snapshot()?.lastControl?.commandId, "command-restart");

  await broker.command(
    decodeCommand({
      type: "dictation.action.acknowledge",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-ack-restart",
      createdAt: "2026-08-29T12:00:04.000Z",
      actionKind: "control",
      acknowledgedCommandId: "command-restart",
    }),
  );
  assert.isUndefined(broker.snapshot()?.lastControl);
});

it("retains the exact vocabulary action for the Shell client", async () => {
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => makeTurnRunningReceipt(),
  });
  await broker.reserve(reserveRequest);

  await broker.command(
    decodeCommand({
      type: "dictation.vocabulary.add",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-vocabulary",
      createdAt: "2026-08-29T12:00:01.000Z",
      word: "Quickshell",
    }),
  );

  assert.deepEqual(broker.snapshot()?.lastVocabulary, {
    commandId: CommandId.make("command-vocabulary"),
    action: "add",
    word: "Quickshell",
  });
});

it("freezes the delivery mode once delivery starts", async () => {
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => makeTurnRunningReceipt(),
  });
  await broker.reserve(reserveRequest);
  await broker.command(makeDeliverCommand());

  await broker.command(
    decodeCommand({
      type: "dictation.mode.set",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-mode-late",
      createdAt: "2026-08-29T12:00:05.000Z",
      mode: "clipboard",
    }),
  );

  assert.equal(broker.snapshot()?.phase, "completed");
  assert.equal(broker.snapshot()?.mode, "submit");
});

it("retries one failed delivery with its original command identity only after explicit retry", async () => {
  let deliveryCount = 0;
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => {
      deliveryCount += 1;
      return deliveryCount === 1
        ? decodeReceipt({
            outcome: "failed",
            protocolVersion: { major: 1, minor: 4 },
            sessionId: "session-a",
            commandId: "command-deliver",
            target: targetA,
            application: "first",
            code: "provider_start_failed",
            detail: "provider did not start",
          })
        : makeTurnRunningReceipt();
    },
  });
  await broker.reserve(reserveRequest);

  await broker.command(makeDeliverCommand());
  await broker.command(makeDeliverCommand());
  assert.equal(deliveryCount, 1);

  await broker.command(
    decodeCommand({
      type: "dictation.control",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-retry",
      createdAt: "2026-08-29T12:00:06.000Z",
      action: "retry",
    }),
  );
  const retried = await broker.command(makeDeliverCommand());

  assert.equal(deliveryCount, 2);
  assert.equal(retried?.outcome, "turn-running");
});

it("does not retry a provider turn that already dispatched and entered error", async () => {
  let deliveryCount = 0;
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => {
      deliveryCount += 1;
      return decodeReceipt({
        outcome: "failed",
        protocolVersion: { major: 1, minor: 5 },
        sessionId: "session-a",
        commandId: "command-deliver",
        target: targetA,
        application: "first",
        code: "provider_turn_failed",
        detail: "the correlated provider turn entered the error state",
      });
    },
  });
  await broker.reserve(reserveRequest);
  await broker.command(makeDeliverCommand());

  await broker.command(
    decodeCommand({
      type: "dictation.control",
      protocolVersion: { major: 1, minor: 5 },
      sessionId: "session-a",
      commandId: "command-retry-turn",
      createdAt: "2026-08-29T12:00:06.000Z",
      action: "retry",
    }),
  );
  const replay = await broker.command(makeDeliverCommand());

  assert.equal(deliveryCount, 1);
  assert.equal(replay?.outcome, "failed");
  if (replay?.outcome === "failed") assert.equal(replay.code, "provider_turn_failed");
  assert.equal(broker.snapshot()?.phase, "failed");
});

it("forwards a correlated late receipt to connected Shell clients", async () => {
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () =>
      decodeReceipt({
        outcome: "confirmation-pending",
        protocolVersion: { major: 1, minor: 4 },
        sessionId: "session-a",
        commandId: "command-deliver",
        target: targetA,
        application: "first",
      }),
  });
  await broker.reserve(reserveRequest);
  await broker.command(makeDeliverCommand());
  const receipts: Array<unknown> = [];
  const unsubscribe = broker.watchReceipts((receipt) => receipts.push(receipt));

  const reported = broker.reportLateReceipt(makeTurnRunningReceipt());
  unsubscribe();

  assert.isTrue(reported);
  assert.equal(broker.snapshot()?.phase, "completed");
  assert.deepEqual(receipts, [makeTurnRunningReceipt()]);
});

it("does not let a pending delivery response overwrite an earlier final receipt", async () => {
  const callbacks: { resolve?: (receipt: ReturnType<typeof decodeReceipt>) => void } = {};
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: () =>
      new Promise((resolve) => {
        callbacks.resolve = resolve;
      }),
  });
  await broker.reserve(reserveRequest);
  const delivery = broker.command(makeDeliverCommand());
  await Promise.resolve();

  const late = makeTurnRunningReceipt();
  assert.isTrue(broker.reportLateReceipt(late));
  callbacks.resolve?.(
    decodeReceipt({
      outcome: "confirmation-pending",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-deliver",
      target: targetA,
      application: "first",
    }),
  );

  const receipt = await delivery;
  assert.equal(receipt?.outcome, "turn-running");
  assert.equal(broker.snapshot()?.phase, "completed");
  assert.isTrue(broker.reportLateReceipt(late));
});

it("retries the original delivery identity after a retryable late failure", async () => {
  let deliveryCount = 0;
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => {
      deliveryCount += 1;
      return deliveryCount === 1
        ? decodeReceipt({
            outcome: "confirmation-pending",
            protocolVersion: { major: 1, minor: 4 },
            sessionId: "session-a",
            commandId: "command-deliver",
            target: targetA,
            application: "first",
          })
        : makeTurnRunningReceipt();
    },
  });
  await broker.reserve(reserveRequest);
  await broker.command(makeDeliverCommand());
  assert.deepEqual(broker.confirmationRecovery(), {
    session: broker.snapshot(),
    commandId: "command-deliver",
  });
  assert.isTrue(
    broker.reportLateReceipt(
      decodeReceipt({
        outcome: "failed",
        protocolVersion: { major: 1, minor: 4 },
        sessionId: "session-a",
        commandId: "command-deliver",
        target: targetA,
        application: "first",
        code: "provider_start_failed",
        detail: "provider did not start",
      }),
    ),
  );
  assert.isNull(broker.confirmationRecovery());

  await broker.command(
    decodeCommand({
      type: "dictation.control",
      protocolVersion: { major: 1, minor: 4 },
      sessionId: "session-a",
      commandId: "command-retry-late",
      createdAt: "2026-08-29T12:00:07.000Z",
      action: "retry",
    }),
  );
  const retried = await broker.command(makeDeliverCommand());

  assert.equal(deliveryCount, 2);
  assert.equal(retried?.outcome, "turn-running");
});

// Acceptance: expiration changes only presentation ownership. It must not
// cancel, fail, or retarget the active recording.
it("hands presentation to Shell when the Mesura visibility lease expires", async () => {
  const scheduled: { expire?: () => void } = {};
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => makeTurnRunningReceipt(),
    scheduleLeaseExpiration: (_expiresAt, expire) => {
      scheduled.expire = expire;
      return () => {
        delete scheduled.expire;
      };
    },
  });
  await broker.reserve(reserveRequest);
  await broker.command(
    decodeCommand({
      type: "dictation.presentation",
      protocolVersion: { major: 1, minor: 2 },
      sessionId: "session-a",
      commandId: "command-presentation",
      createdAt: "2026-08-29T12:00:01.000Z",
      target: targetA,
      focused: true,
      visible: true,
      displayedTarget: true,
      leaseExpiresAt: "2026-08-29T12:00:03.000Z",
    }),
  );

  scheduled.expire?.();

  assert.equal(broker.snapshot()?.presentation.mesuraOwnsPresentation, false);
  assert.equal(broker.snapshot()?.presentation.leaseExpiresAt, null);
  assert.equal(broker.snapshot()?.phase, "recording");
  assert.deepEqual(broker.snapshot()?.target, targetA);
});

it("accepts a new reservation after the prior session reaches a terminal phase", async () => {
  const broker = createDictationBroker({
    reserveTarget: async (request) => ({
      target: request.sessionId === reserveRequest.sessionId ? targetA : targetB,
      projectName: "Project",
    }),
    deliver: async () => makeTurnRunningReceipt(),
  });
  await broker.reserve(reserveRequest);
  await broker.command(makeDeliverCommand());

  const second = await broker.reserve(makeReserveRequest("session-b", "command-reserve-b"));

  assert.equal(second.sessionId, "session-b");
  assert.deepEqual(second.target, targetB);
  assert.equal(second.phase, "recording");
});

it("rejects a different session while the first reservation is in flight", async () => {
  const callbacks: { resolve?: (value: { target: typeof targetA; projectName: string }) => void } =
    {};
  let reservationCount = 0;
  const broker = createDictationBroker({
    reserveTarget: () => {
      reservationCount += 1;
      return new Promise((resolve) => {
        callbacks.resolve = resolve;
      });
    },
    deliver: async () => makeTurnRunningReceipt(),
  });

  const first = broker.reserve(reserveRequest);
  const secondError = await broker
    .reserve(makeReserveRequest("session-b", "command-reserve-b"))
    .then(() => null)
    .catch((cause: unknown) => cause);
  callbacks.resolve?.({ target: targetA, projectName: "Project A" });
  await first;

  assert.equal(reservationCount, 1);
  assert.instanceOf(secondError, Error);
  assert.include((secondError as Error).message, "in progress");
});

it("returns a typed failed receipt when renderer delivery rejects", async () => {
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => {
      throw new Error("renderer disconnected");
    },
  });
  await broker.reserve(reserveRequest);

  const receipt = await broker.command(makeDeliverCommand());

  assert.equal(receipt?.outcome, "failed");
  if (receipt?.outcome !== "failed") return;
  assert.equal(receipt.code, "renderer_lost");
  assert.equal(broker.snapshot()?.phase, "failed");
});

it.each([
  { name: "session", override: { sessionId: "session-other" } },
  { name: "command", override: { commandId: "command-other" } },
  { name: "target", override: { target: targetB } },
])("refuses a renderer receipt for another $name identity", async ({ override }) => {
  const broker = createDictationBroker({
    reserveTarget: async () => ({ target: targetA, projectName: "Project A" }),
    deliver: async () => decodeReceipt({ ...makeTurnRunningReceipt(), ...override }),
  });
  await broker.reserve(reserveRequest);

  const receipt = await broker.command(makeDeliverCommand());

  assert.equal(receipt?.outcome, "failed");
  if (receipt?.outcome !== "failed") return;
  assert.equal(receipt.code, "malformed_input");
  assert.equal(receipt.sessionId, "session-a");
  assert.equal(receipt.commandId, "command-deliver");
  assert.deepEqual(receipt.target, targetA);
});

it("removes a renderer request when webContents.send throws", async () => {
  const bridge = createRendererRequestBridge({
    newRequestId: () => "renderer-request-a",
    send: () => {
      throw new Error("window was destroyed");
    },
  });

  const dispatch = bridge.dispatch({ kind: "reserve-target", request: reserveRequest });
  const failure = await dispatch.response.then(() => null).catch((cause: unknown) => cause);

  assert.instanceOf(failure, Error);
  assert.equal(bridge.pendingCount(), 0);
});

// The old path remains a distinct refusal-only endpoint during rollout. It
// cannot silently turn a destination-less request into the new path.
it.effect("keeps the destination-less stt socket as a distinct compatibility endpoint", () =>
  Effect.gen(function* () {
    const runtimeDir = "/run/user/1000";
    const pid = 4242;
    const legacyPath = yield* sttSocketPath(runtimeDir, pid);
    const sessionPath = yield* dictationSocketPath(runtimeDir, pid);

    assert.equal(legacyPath, "/run/user/1000/symmetria-mesura-4242.sock");
    assert.equal(sessionPath, "/run/user/1000/symmetria-mesura-dictation-4242.sock");
    assert.notEqual(legacyPath, sessionPath);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Acceptance: this optional integration can fail closed without rejecting the
// Electron application layer that owns it.
it.effect("converts any broker startup failure into an unavailable service", () =>
  Effect.gen(function* () {
    const failures: Array<string> = [];
    const result = yield* isolateDictationBrokerStartup({
      start: Effect.fail("IPC registration failed"),
      fallback: () => "unavailable",
      onFailure: (cause) =>
        Effect.sync(() => {
          failures.push(cause.toString());
        }),
    });

    assert.equal(result, "unavailable");
    assert.include(failures[0] ?? "", "IPC registration failed");
  }),
);
