import {
  SymmetriaDraftVersion,
  type SymmetriaDictationCommand,
  type SymmetriaDictationReceipt,
  type SymmetriaDictationSession,
  type SymmetriaDictationTarget,
} from "@symmetria/broker-contract";
import { MessageId, type CommandId, type ScopedThreadRef } from "@t3tools/contracts";

import {
  DraftId,
  appendPersistedDictation,
  useComposerDraftStore,
  type PersistedDictationAppendResult,
  type DictationPersistenceFailure,
} from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import { dictationTargetsEqual, resolveDictationTarget } from "./dictationTarget";
import {
  submitDirectedDictation,
  type DirectedComposerSubmissionResult,
  type DirectedSubmissionContext,
} from "./directedComposerSubmission";
import { confirmDirectedDictationTurn } from "./dictationTurnConfirmation";

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
  readonly readSubmissionContext?: () => DirectedSubmissionContext | null;
};

type CoordinatorOptions = {
  readonly append?: (
    target: Parameters<typeof appendPersistedDictation>[0],
    commandId: CommandId,
    transcript: string,
    sourceTargetKey?: string | null,
  ) => Promise<PersistedDictationAppendResult>;
  readonly threadExists?: (threadRef: ScopedThreadRef) => boolean;
  readonly submit?: typeof submitDirectedDictation;
  readonly confirm?: typeof confirmDirectedDictationTurn;
  readonly reportLateReceipt?: (receipt: SymmetriaDictationReceipt) => void;
  readonly reportPersistenceFailure?: (event: DictationPersistenceDiagnosticEvent) => void;
};

export type DictationPersistenceDiagnosticEvent = DictationPersistenceFailure & {
  readonly event: "symmetria.dictation.persistence.failed";
  readonly sessionId: string;
  readonly commandId: string;
  readonly target: SymmetriaDictationTarget;
};

const failedReceipt = (
  command: Extract<SymmetriaDictationCommand, { type: "dictation.deliver" }>,
  target: SymmetriaDictationTarget,
  code: "renderer_lost" | "persistence_failed" | "provider_start_failed",
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
  const submit = options.submit ?? submitDirectedDictation;
  const confirm = options.confirm ?? confirmDirectedDictationTurn;
  const reportLateReceipt =
    options.reportLateReceipt ??
    ((receipt: SymmetriaDictationReceipt) => {
      if (typeof window === "undefined") return;
      void window.symmetriaDictationBridge?.sendCommand({
        type: "dictation.late-receipt",
        receipt,
      });
    });
  const reportPersistenceFailure =
    options.reportPersistenceFailure ??
    ((event: DictationPersistenceDiagnosticEvent) => {
      console.error(event.event, event);
    });
  const safelyReportPersistenceFailure = (event: DictationPersistenceDiagnosticEvent): void => {
    try {
      reportPersistenceFailure(event);
    } catch (cause) {
      try {
        console.error("symmetria.dictation.persistence.reporter-failed", {
          sessionId: event.sessionId,
          commandId: event.commandId,
          stage: event.stage,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      } catch {
        // Diagnostics must never alter delivery behavior.
      }
    }
  };
  let registration: (DictationComposerRegistration & { readonly token: symbol }) | null = null;
  let reservation: {
    readonly sessionId: string;
    readonly target: SymmetriaDictationTarget;
    readonly projectName: string | null;
    readonly submissionContext: DirectedSubmissionContext | null;
  } | null = null;
  let resumedConfirmationKey: string | null = null;

  const restoreSession = (session: SymmetriaDictationSession | null): void => {
    if (session === null) {
      reservation = null;
      resumedConfirmationKey = null;
      return;
    }
    if (
      reservation?.sessionId === session.sessionId &&
      dictationTargetsEqual(reservation.target, session.target)
    ) {
      return;
    }
    reservation = {
      sessionId: session.sessionId,
      target: session.target,
      projectName: session.projectName,
      submissionContext: null,
    };
    resumedConfirmationKey = null;
  };

  const resumeConfirmation = async (
    session: SymmetriaDictationSession,
    commandId: CommandId,
  ): Promise<void> => {
    restoreSession(session);
    if (session.phase !== "confirming") return;
    const recoveryKey = `${session.sessionId}:${commandId}`;
    if (resumedConfirmationKey === recoveryKey) return;
    resumedConfirmationKey = recoveryKey;
    const threadRef =
      session.target.kind === "draft" ? session.target.futureThreadRef : session.target;
    const messageId = MessageId.make(`dictation-${commandId}`);
    try {
      const receipt = await confirm(
        {
          protocolVersion: session.protocolVersion,
          sessionId: session.sessionId,
          commandId,
          target: session.target,
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          messageId,
        },
        { onLateReceipt: reportLateReceipt },
      );
      if (receipt.outcome !== "confirmation-pending") reportLateReceipt(receipt);
    } catch (cause) {
      if (resumedConfirmationKey === recoveryKey) resumedConfirmationKey = null;
      throw cause;
    }
  };

  return {
    restoreSession,
    resumeConfirmation,
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
        submissionContext: registration.readSubmissionContext?.() ?? null,
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
        if (result.reason === "persistence-failed") {
          safelyReportPersistenceFailure({
            event: "symmetria.dictation.persistence.failed",
            sessionId: command.sessionId,
            commandId: command.commandId,
            target: reserved.target,
            stage: result.stage,
            persistedBytes: result.persistedBytes,
            ...(result.expectedPromptHash ? { expectedPromptHash: result.expectedPromptHash } : {}),
            ...(result.actualPromptHash ? { actualPromptHash: result.actualPromptHash } : {}),
          });
        }
        return failedReceipt(
          command,
          reserved.target,
          result.reason === "persistence-failed" ? "persistence_failed" : "renderer_lost",
          result.reason === "persistence-failed"
            ? `dictation persistence verification failed at ${result.stage}`
            : result.reason,
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

      if (command.mode === "submit") {
        const messageId = MessageId.make(`dictation-${command.commandId}`);
        let submission: DirectedComposerSubmissionResult;
        try {
          const submissionContext =
            registration !== null && dictationTargetsEqual(registration.target, reserved.target)
              ? (registration.readSubmissionContext?.() ?? reserved.submissionContext)
              : reserved.submissionContext;
          submission = await submit({
            command,
            reservedTarget: reserved.target,
            composerTarget: resolved.target,
            prompt: result.prompt,
            messageId,
            submissionContext,
            sourceComposerTarget:
              resolved.sourceTargetKey === null ? null : DraftId.make(resolved.sourceTargetKey),
          });
        } catch (cause) {
          return failedReceipt(
            command,
            reserved.target,
            "provider_start_failed",
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        if (submission.kind === "refused") {
          return {
            outcome: "refused",
            protocolVersion: command.protocolVersion,
            sessionId: command.sessionId,
            commandId: command.commandId,
            target: reserved.target,
            application: result.application,
            code: submission.code,
            detail: "the current composer action does not accept free-form text",
          };
        }
        if (submission.kind === "provider-start-failed") {
          return failedReceipt(
            command,
            reserved.target,
            "provider_start_failed",
            "the provider turn did not start",
          );
        }
        if (submission.kind === "answer-submit-failed") {
          return failedReceipt(
            command,
            reserved.target,
            "provider_start_failed",
            "the pending answer was not accepted",
          );
        }
        if (submission.kind === "answer-submitted") {
          return {
            outcome: "inserted",
            protocolVersion: command.protocolVersion,
            sessionId: command.sessionId,
            commandId: command.commandId,
            target: reserved.target,
            application: result.application,
            draftVersion: SymmetriaDraftVersion.make(result.version),
            action: "answer",
          };
        }
        const confirmationRef =
          typeof resolved.target === "string"
            ? reserved.target.kind === "draft"
              ? reserved.target.futureThreadRef
              : null
            : resolved.target;
        if (confirmationRef === null) {
          return failedReceipt(
            command,
            reserved.target,
            "provider_start_failed",
            "the submitted thread identity is unavailable",
          );
        }
        const confirmationKey = `${command.sessionId}:${command.commandId}`;
        resumedConfirmationKey = confirmationKey;
        const confirmationIdentity = {
          protocolVersion: command.protocolVersion,
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: reserved.target,
          environmentId: confirmationRef.environmentId,
          threadId: confirmationRef.threadId,
          messageId: submission.messageId,
        } as const;
        void Promise.resolve()
          .then(() => confirm(confirmationIdentity, { onLateReceipt: reportLateReceipt }))
          .then((receipt) => {
            if (receipt.outcome !== "confirmation-pending") reportLateReceipt(receipt);
          })
          .catch((cause: unknown) => {
            reportLateReceipt(
              failedReceipt(
                command,
                reserved.target,
                "renderer_lost",
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
          });
        return {
          outcome: "confirmation-pending",
          protocolVersion: command.protocolVersion,
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: reserved.target,
          application: result.application,
        };
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
