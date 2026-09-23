import { questionAttachmentDraftPrefix } from "../questionAttachments";
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

export type DictationQuestionTarget = {
  readonly isAvailable: () => boolean;
  readonly append: (
    commandId: CommandId,
    text: string,
  ) => { readonly application: "first" | "replay"; readonly version: number };
};

export type DictationComposerRegistration = {
  readonly questionTarget?: DictationQuestionTarget;
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
  // A focused question overrides the normal composer. Removing it restores the
  // current composer, even when its metadata changed while the question had focus.
  const registrations = new Map<symbol, DictationComposerRegistration>();
  const clearQuestionTarget = () => {
    for (const [token, entry] of registrations)
      if (entry.questionTarget) registrations.delete(token);
  };
  const activeRegistration = () => {
    const entries = [...registrations.values()];
    return (
      entries.findLast((entry) => entry.questionTarget !== undefined) ?? entries.at(-1) ?? null
    );
  };
  let reservation: {
    readonly sessionId: string;
    readonly target: SymmetriaDictationTarget;
    readonly projectName: string | null;
    readonly submissionContext: DirectedSubmissionContext | null;
    readonly questionTarget?: DictationQuestionTarget;
  } | null = null;

  const restoreSession = (session: SymmetriaDictationSession | null): void => {
    if (session === null) {
      reservation = null;
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
  };

  return {
    restoreSession,
    clearQuestionTarget,
    registerComposer: (next: DictationComposerRegistration): (() => void) => {
      const token = Symbol("dictation-composer-registration");
      if (next.questionTarget) clearQuestionTarget();
      registrations.set(token, next);
      return () => {
        registrations.delete(token);
      };
    },

    reserve: async (request: DictationReservationRequest) => {
      if (reservation?.sessionId === request.sessionId) {
        return { target: reservation.target, projectName: reservation.projectName };
      }
      const registration = activeRegistration();
      if (registration === null) throw new Error("no composer target is registered");
      const reserved = {
        ...(registration.questionTarget ? { questionTarget: registration.questionTarget } : {}),
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
      const registration = activeRegistration();
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

      // Capture the question at reservation time. A later focus change must
      // never route this transcript into another question or the normal composer.
      if (reserved.questionTarget) {
        if (!reserved.questionTarget.isAvailable()) {
          return {
            outcome: "refused",
            protocolVersion: command.protocolVersion,
            sessionId: command.sessionId,
            commandId: command.commandId,
            target: reserved.target,
            application: "first",
            code: "target_missing",
            detail: "The question is no longer available.",
          };
        }
        const result = reserved.questionTarget.append(command.commandId, command.text);
        return {
          outcome: "inserted",
          protocolVersion: command.protocolVersion,
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: reserved.target,
          application: result.application,
          draftVersion: SymmetriaDraftVersion.make(result.version),
        };
      }

      // A restored question reservation cannot use the promoted-draft fallback:
      // that fallback targets the normal message composer after a reload.
      if (
        reserved.target.kind === "draft" &&
        reserved.target.draftId.startsWith(
          questionAttachmentDraftPrefix(
            reserved.target.futureThreadRef.environmentId,
            reserved.target.futureThreadRef.threadId,
          ),
        )
      ) {
        return {
          outcome: "refused",
          protocolVersion: command.protocolVersion,
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: reserved.target,
          application: "first",
          code: "target_missing",
          detail: "Focus the question and record again.",
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
        return failedReceipt(command, reserved.target, "renderer_lost", result.reason);
      }
      if (result.persistenceFailure) {
        const failure = result.persistenceFailure;
        safelyReportPersistenceFailure({
          event: "symmetria.dictation.persistence.failed",
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: reserved.target,
          stage: failure.stage,
          persistedBytes: failure.persistedBytes,
          ...(failure.expectedPromptHash ? { expectedPromptHash: failure.expectedPromptHash } : {}),
          ...(failure.actualPromptHash ? { actualPromptHash: failure.actualPromptHash } : {}),
        });
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
        return {
          outcome: "inserted",
          protocolVersion: command.protocolVersion,
          sessionId: command.sessionId,
          commandId: command.commandId,
          target: reserved.target,
          application: result.application,
          draftVersion: SymmetriaDraftVersion.make(result.version),
          action: "submit",
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
