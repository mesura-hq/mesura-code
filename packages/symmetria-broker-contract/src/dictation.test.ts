import { CommandId, EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SYMMETRIA_DICTATION_PHASES,
  SYMMETRIA_DICTATION_RECEIPT_OUTCOMES,
  SymmetriaDictationCommand,
  SymmetriaDictationPhase,
  SymmetriaDictationReceipt,
  SymmetriaDictationSession,
  SymmetriaDictationTarget,
} from "./dictation.ts";
import { buildSymmetriaJsonSchemaArtifacts, SYMMETRIA_SCHEMA_ROOTS } from "./jsonSchema.ts";

const PROTOCOL_VERSION = { major: 1, minor: 2 } as const;
const SESSION_ID = "stt_01K3PH7X2A";
const COMMAND_ID = CommandId.make("cmd_01K3PH8B65");
const ENVIRONMENT_ID = EnvironmentId.make("env_local");
const THREAD_ID = ThreadId.make("thr_reserved");
const FUTURE_THREAD_ID = ThreadId.make("thr_future");

const threadTarget = {
  kind: "thread",
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
} as const;

const draftTarget = {
  kind: "draft",
  draftId: "draft_01K3PH9A81",
  futureThreadRef: {
    environmentId: ENVIRONMENT_ID,
    threadId: FUTURE_THREAD_ID,
  },
} as const;

const decodeTarget = Schema.decodeUnknownResult(SymmetriaDictationTarget);
const decodeTargetOrThrow = Schema.decodeUnknownSync(SymmetriaDictationTarget);
const decodePhase = Schema.decodeUnknownResult(SymmetriaDictationPhase);
const decodeCommand = Schema.decodeUnknownResult(SymmetriaDictationCommand);
const decodeReceipt = Schema.decodeUnknownResult(SymmetriaDictationReceipt);
const decodeSession = Schema.decodeUnknownResult(SymmetriaDictationSession);

const omit = <T extends Record<string, unknown>>(value: T, key: keyof T) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

describe("SymmetriaDictationTarget", () => {
  it("distinguishes a scoped server thread from a draft with its future thread", () => {
    expect(Result.isSuccess(decodeTarget(threadTarget))).toBe(true);
    expect(Result.isSuccess(decodeTarget(draftTarget))).toBe(true);
    expect(Result.isFailure(decodeTarget(omit(draftTarget, "futureThreadRef")))).toBe(true);
  });

  it("requires the environment boundary on every server thread address", () => {
    expect(Result.isFailure(decodeTarget(omit(threadTarget, "environmentId")))).toBe(true);
    expect(Result.isFailure(decodeTarget(omit(threadTarget, "threadId")))).toBe(true);

    expect(
      Result.isFailure(
        decodeTarget({
          ...draftTarget,
          futureThreadRef: omit(draftTarget.futureThreadRef, "environmentId"),
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeTarget({
          ...draftTarget,
          futureThreadRef: omit(draftTarget.futureThreadRef, "threadId"),
        }),
      ),
    ).toBe(true);

    const sameThreadElsewhere = {
      ...threadTarget,
      environmentId: EnvironmentId.make("env_remote"),
    };
    const local = decodeTargetOrThrow(threadTarget);
    const remote = decodeTargetOrThrow(sameThreadElsewhere);
    expect(local).not.toEqual(remote);
  });
});

describe("SymmetriaDictationPhase", () => {
  it("covers every canonical session phase and refuses an invented one", () => {
    expect(SYMMETRIA_DICTATION_PHASES).toEqual([
      "recording",
      "paused",
      "processing",
      "grace",
      "delivering",
      "confirming",
      "completed",
      "failed",
      "cancelled",
    ]);
    for (const phase of SYMMETRIA_DICTATION_PHASES) {
      expect(Result.isSuccess(decodePhase(phase))).toBe(true);
    }
    expect(Result.isFailure(decodePhase("transcribed"))).toBe(true);
  });

  it("refuses non-finite audio levels in every JSON representation", () => {
    const session = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      target: threadTarget,
      source: "shell",
      phase: "recording",
      mode: "submit",
      projectName: "mesura-code",
      startedAt: "2026-08-29T12:00:00.000Z",
      elapsedMs: 1200,
      audioLevel: 0.42,
      graceRemainingMs: null,
      presentation: { mesuraOwnsPresentation: true, leaseExpiresAt: null },
    } as const;
    expect(Result.isSuccess(decodeSession(session))).toBe(true);
    for (const audioLevel of ["NaN", "Infinity", "-Infinity"]) {
      expect(Result.isFailure(decodeSession({ ...session, audioLevel }))).toBe(true);
    }
  });
});

describe("SymmetriaDictationCommand", () => {
  it("requires stable session and command identities on controls and delivery", () => {
    const control = {
      type: "dictation.control",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      commandId: COMMAND_ID,
      createdAt: "2026-08-29T12:00:00.000Z",
      action: "pause",
    } as const;
    const delivery = {
      type: "dictation.deliver",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      commandId: CommandId.make("cmd_01K3PHA3Q9"),
      createdAt: "2026-08-29T12:01:00.000Z",
      target: threadTarget,
      mode: "submit",
      text: "[voiced] keep the original thread",
    } as const;

    for (const command of [control, delivery]) {
      expect(Result.isSuccess(decodeCommand(command))).toBe(true);
      expect(Result.isFailure(decodeCommand(omit(command, "sessionId")))).toBe(true);
      expect(Result.isFailure(decodeCommand(omit(command, "commandId")))).toBe(true);
    }
  });
});

describe("SymmetriaDictationReceipt", () => {
  it("distinguishes every delivery outcome and requires exact running-turn identity", () => {
    expect(SYMMETRIA_DICTATION_RECEIPT_OUTCOMES).toEqual([
      "copied",
      "inserted",
      "turn-running",
      "confirmation-pending",
      "refused",
      "failed",
    ]);

    const receiptBase = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      commandId: COMMAND_ID,
      target: threadTarget,
      application: "first",
    } as const;
    const running = {
      ...receiptBase,
      outcome: "turn-running",
      messageId: MessageId.make("msg_01K3PHB00M"),
      turnId: TurnId.make("turn_01K3PHB6D2"),
    } as const;
    const validReceipts = [
      { ...receiptBase, outcome: "copied" },
      { ...receiptBase, outcome: "inserted", draftVersion: 3 },
      { ...receiptBase, outcome: "inserted", draftVersion: 4, action: "answer" },
      running,
      { ...receiptBase, outcome: "confirmation-pending" },
      {
        ...receiptBase,
        outcome: "refused",
        code: "target_missing",
        detail: "the reserved thread no longer exists",
      },
      {
        ...receiptBase,
        outcome: "failed",
        code: "provider_start_failed",
        detail: null,
      },
    ];
    for (const receipt of validReceipts) {
      expect(Result.isSuccess(decodeReceipt(receipt)), receipt.outcome).toBe(true);
    }
    expect(Result.isFailure(decodeReceipt(omit(running, "application")))).toBe(true);
    expect(Result.isFailure(decodeReceipt(omit(running, "messageId")))).toBe(true);
    expect(Result.isFailure(decodeReceipt(omit(running, "turnId")))).toBe(true);
    expect(
      Result.isFailure(
        decodeReceipt({ ...receiptBase, outcome: "inserted", draftVersion: 4, action: "submit" }),
      ),
    ).toBe(true);
  });
});

describe("dictation protocol compatibility", () => {
  it("drops additive fields, accepts a newer minor, and refuses another major", () => {
    const command = {
      type: "dictation.control",
      protocolVersion: { major: 1, minor: 99 },
      sessionId: SESSION_ID,
      commandId: COMMAND_ID,
      createdAt: "2026-08-29T12:00:00.000Z",
      action: "cancel",
      addedLater: { opaque: true },
    };
    const decoded = decodeCommand(command);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(Object.hasOwn(decoded.success, "addedLater")).toBe(false);
    }
    expect(
      Result.isFailure(decodeCommand({ ...command, protocolVersion: { major: 2, minor: 0 } })),
    ).toBe(true);
  });

  it("publishes JSON Schema documents for the session, command, and receipt roots", () => {
    const expectedFiles = [
      "dictationSession.schema.json",
      "dictationCommand.schema.json",
      "dictationReceipt.schema.json",
    ];
    expect(SYMMETRIA_SCHEMA_ROOTS.map((root) => root.file)).toEqual(
      expect.arrayContaining(expectedFiles),
    );
    expect(buildSymmetriaJsonSchemaArtifacts().map((artifact) => artifact.file)).toEqual(
      expect.arrayContaining(expectedFiles),
    );
  });
});
