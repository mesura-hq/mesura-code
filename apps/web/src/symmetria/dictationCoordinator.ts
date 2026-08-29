import {
  SymmetriaDraftVersion,
  type SymmetriaDictationCommand,
  type SymmetriaDictationReceipt,
  type SymmetriaDictationTarget,
} from "@symmetria/broker-contract";
import type { CommandId, ScopedThreadRef } from "@t3tools/contracts";

import {
  appendPersistedDictation,
  useComposerDraftStore,
  type PersistedDictationAppendResult,
} from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import { dictationTargetsEqual, resolveDictationTarget } from "./dictationTarget";

export type DictationReservationRequest = {
  readonly protocolVersion: { readonly major: 1; readonly minor: number };
  readonly sessionId: string;
  readonly commandId: CommandId;
  readonly createdAt: string;
  readonly source: "shell" | "mesura";
};

export type DictationComposerHandle = {
  readonly replacePrompt: (prompt: string) => boolean;
};

export type DictationComposerRegistration = {
  readonly target: SymmetriaDictationTarget;
  readonly projectName: string | null;
  readonly handle: DictationComposerHandle | null;
};

type CoordinatorOptions = {
  readonly append?: (
    target: Parameters<typeof appendPersistedDictation>[0],
    commandId: CommandId,
    transcript: string,
    sourceTargetKey?: string | null,
  ) => Promise<PersistedDictationAppendResult>;
  readonly threadExists?: (threadRef: ScopedThreadRef) => boolean;
};

const failedReceipt = (
  command: Extract<SymmetriaDictationCommand, { type: "dictation.deliver" }>,
  target: SymmetriaDictationTarget,
  code: "renderer_lost" | "persistence_failed",
  detail: string,
): SymmetriaDictationReceipt => ({
  outcome: "failed",
  protocolVersion: command.protocolVersion,
  sessionId: command.sessionId,
  commandId: command.commandId,
  target,
  application: "first",
  code,
  detail,
});

export function createDictationCoordinator(options: CoordinatorOptions = {}) {
  const append = options.append ?? appendPersistedDictation;
  const threadExists =
    options.threadExists ??
    ((threadRef: ScopedThreadRef) =>
      appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef)) !== null);
  let registration: (DictationComposerRegistration & { readonly token: symbol }) | null = null;
  let reservation: {
    readonly sessionId: string;
    readonly target: SymmetriaDictationTarget;
    readonly projectName: string | null;
  } | null = null;

  return {
    registerComposer: (next: DictationComposerRegistration): (() => void) => {
      const token = Symbol("dictation-composer-registration");
      registration = { ...next, token };
      return () => {
        if (registration?.token === token) registration = null;
      };
    },

    reserve: async (request: DictationReservationRequest) => {
      if (reservation?.sessionId === request.sessionId) {
        return { target: reservation.target, projectName: reservation.projectName };
      }
      if (registration === null) throw new Error("no composer target is registered");
      const reserved = {
        sessionId: request.sessionId,
        target: registration.target,
        projectName: registration.projectName,
      };
      reservation = reserved;
      return { target: reserved.target, projectName: reserved.projectName };
    },

    deliver: async (
      command: Extract<SymmetriaDictationCommand, { type: "dictation.deliver" }>,
    ): Promise<SymmetriaDictationReceipt> => {
      const reserved = reservation?.sessionId === command.sessionId ? reservation : null;
      const receiptTarget = reserved?.target ?? command.target;
      if (reserved === null || !dictationTargetsEqual(reserved.target, command.target)) {
        return {
          outcome: "refused",
          protocolVersion: command.protocolVersion,
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: receiptTarget,
          application: "first",
          code: "target_missing",
          detail: "the reserved composer target is unavailable",
        };
      }
      if (command.mode === "clipboard") {
        return {
          outcome: "copied",
          protocolVersion: command.protocolVersion,
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: reserved.target,
          application: "first",
        };
      }

      const resolved = resolveDictationTarget(
        reserved.target,
        useComposerDraftStore.getState(),
        threadExists,
      );
      if (!resolved.ok) {
        return {
          outcome: "refused",
          protocolVersion: command.protocolVersion,
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: reserved.target,
          application: "first",
          code: "target_missing",
          detail: resolved.reason,
        };
      }

      const result = await append(
        resolved.target,
        command.commandId,
        command.text,
        resolved.sourceTargetKey,
      );
      if (!result.ok) {
        return failedReceipt(
          command,
          reserved.target,
          result.reason === "persistence-failed" ? "persistence_failed" : "renderer_lost",
          result.reason,
        );
      }

      if (
        registration !== null &&
        dictationTargetsEqual(registration.target, reserved.target) &&
        registration.handle !== null &&
        !registration.handle.replacePrompt(result.prompt)
      ) {
        return failedReceipt(
          command,
          reserved.target,
          "renderer_lost",
          "the mounted composer rejected the persisted prompt",
        );
      }

      return {
        outcome: "inserted",
        protocolVersion: command.protocolVersion,
        sessionId: command.sessionId,
        commandId: command.commandId,
        target: reserved.target,
        application: result.application,
        draftVersion: SymmetriaDraftVersion.make(result.version),
      };
    },
  };
}

export const dictationCoordinator = createDictationCoordinator();
