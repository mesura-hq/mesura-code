import type {
  RespondToThreadUserInputInput,
  StartThreadTurnInput,
} from "@t3tools/client-runtime/state/threads";
import {
  OrchestrationProposedPlanId,
  type ApprovalRequestId,
  type CommandId,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
  type ThreadTurnStartBootstrap,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

import { useComposerDraftStore, DraftId, type DraftSessionState } from "../composerDraftStore";
import { deriveComposerSendState, readFileAsDataUrl } from "../components/ChatView.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { appendElementContextsToPrompt } from "../lib/elementContext";
import { appendTerminalContextsToPrompt } from "../lib/terminalContext";
import { appendPreviewAnnotationPrompt } from "../lib/previewAnnotation";
import { appendReviewCommentsToPrompt } from "../reviewCommentContext";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "../session-logic";
import { resolvePlanFollowUpSubmission } from "../proposedPlan";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import {
  formatOutgoingComposerPrompt,
  getComposerPromptLengthValidationMessage,
} from "../components/chat/composerSubmission";
import type { ComposerDictationTarget } from "./dictationTarget";
import type {
  SymmetriaDictationCommand,
  SymmetriaDictationTarget,
} from "@symmetria/broker-contract";

export type DirectedComposerPendingAction =
  | { readonly kind: "composer" }
  | {
      readonly kind: "text-question";
      readonly requestId: ApprovalRequestId;
      readonly questionId: string;
      readonly questions?: ReadonlyArray<UserInputQuestion>;
      readonly draftAnswers?: Readonly<Record<string, PendingUserInputDraftAnswer>>;
      readonly questionIndex?: number;
    }
  | {
      readonly kind: "plan-follow-up";
      readonly planId: string;
      readonly planMarkdown: string;
    }
  | { readonly kind: "button-approval" };

export type DirectedComposerSubmission = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly createdAt: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection | undefined;
  readonly titleSeed: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly attachments: StartThreadTurnInput["message"]["attachments"];
  readonly bootstrap: ThreadTurnStartBootstrap | undefined;
  readonly pendingAction: DirectedComposerPendingAction;
};

export type DirectedSubmissionContext = {
  readonly providerAvailable: boolean;
  readonly provider: Parameters<typeof formatOutgoingComposerPrompt>[0]["provider"];
  readonly model: string | null;
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
  readonly effort: string | null;
  readonly pendingAction: DirectedComposerPendingAction;
};

export function prepareDirectedProviderPrompt(
  text: string,
  context: DirectedSubmissionContext | null | undefined,
): { readonly ok: true; readonly prompt: string } | { readonly ok: false } {
  if (context?.providerAvailable === false) return { ok: false };
  const prompt = context
    ? formatOutgoingComposerPrompt({
        provider: context.provider,
        model: context.model,
        models: context.models,
        effort: context.effort,
        text,
      })
    : text;
  return getComposerPromptLengthValidationMessage(prompt) === null
    ? { ok: true, prompt }
    : { ok: false };
}

export function hasValidDirectedWorktreeSelection(
  draftSession: Pick<DraftSessionState, "envMode" | "worktreePath" | "branch">,
): boolean {
  return !(
    draftSession.envMode === "worktree" &&
    draftSession.worktreePath === null &&
    draftSession.branch === null
  );
}

export function consumeDirectedComposerDraft(
  target: ComposerDictationTarget,
  sourceTarget: ComposerDictationTarget | null | undefined,
): void {
  useComposerDraftStore.getState().clearComposerContent(target);
  if (sourceTarget !== undefined && sourceTarget !== null && sourceTarget !== target) {
    useComposerDraftStore.getState().clearComposerContent(sourceTarget);
  }
}

export type DirectedComposerSubmissionResult =
  | { readonly kind: "turn-dispatched"; readonly messageId: MessageId }
  | { readonly kind: "answer-submitted" }
  | { readonly kind: "provider-start-failed"; readonly messageId: MessageId }
  | { readonly kind: "answer-submit-failed" }
  | { readonly kind: "refused"; readonly code: "unsupported_composer_action" };

export type DirectedComposerSubmissionDependencies = {
  readonly startTurn: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: StartThreadTurnInput;
  }) => Promise<boolean>;
  readonly answerQuestion: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: RespondToThreadUserInputInput;
  }) => Promise<boolean>;
};

async function submitDirectedComposer(
  submission: DirectedComposerSubmission,
  dependencies: DirectedComposerSubmissionDependencies,
): Promise<DirectedComposerSubmissionResult> {
  if (submission.pendingAction.kind === "button-approval") {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  if (submission.pendingAction.kind === "text-question") {
    const questions = submission.pendingAction.questions;
    const answers = questions
      ? (() => {
          const progress = derivePendingUserInputProgress(
            questions,
            submission.pendingAction.draftAnswers ?? {},
            submission.pendingAction.questionIndex ?? 0,
          );
          if (progress.activeQuestion === null) return null;
          const nextDraftAnswers = {
            ...submission.pendingAction.draftAnswers,
            [progress.activeQuestion.id]: setPendingUserInputCustomAnswer(
              submission.pendingAction.draftAnswers?.[progress.activeQuestion.id],
              submission.prompt,
            ),
          };
          return buildPendingUserInputAnswers(questions, nextDraftAnswers);
        })()
      : { [submission.pendingAction.questionId]: submission.prompt };
    if (answers === null) {
      return { kind: "refused", code: "unsupported_composer_action" };
    }
    const answered = await dependencies.answerQuestion({
      environmentId: submission.environmentId,
      input: {
        commandId: submission.commandId,
        threadId: submission.threadId,
        requestId: submission.pendingAction.requestId,
        answers,
        createdAt: submission.createdAt,
      },
    });
    return answered ? { kind: "answer-submitted" } : { kind: "answer-submit-failed" };
  }

  const input = buildDirectedTurnStartInput(submission);
  const started = await dependencies.startTurn({
    environmentId: submission.environmentId,
    input,
  });
  return started
    ? { kind: "turn-dispatched", messageId: submission.messageId }
    : { kind: "provider-start-failed", messageId: submission.messageId };
}

export function buildDirectedTurnStartInput(
  submission: DirectedComposerSubmission,
): StartThreadTurnInput {
  const planFollowUp =
    submission.pendingAction.kind === "plan-follow-up"
      ? resolvePlanFollowUpSubmission({
          draftText: submission.prompt,
          planMarkdown: submission.pendingAction.planMarkdown,
        })
      : null;
  const interactionMode = planFollowUp?.interactionMode ?? submission.interactionMode;
  const text = planFollowUp?.text ?? submission.prompt;
  return {
    commandId: submission.commandId,
    threadId: submission.threadId,
    message: {
      messageId: submission.messageId,
      role: "user",
      text,
      attachments: [...submission.attachments],
    },
    ...(submission.modelSelection ? { modelSelection: submission.modelSelection } : {}),
    titleSeed: submission.titleSeed,
    runtimeMode: submission.runtimeMode,
    interactionMode,
    ...(submission.bootstrap ? { bootstrap: submission.bootstrap } : {}),
    ...(planFollowUp?.interactionMode === "default" &&
    submission.pendingAction.kind === "plan-follow-up"
      ? {
          sourceProposedPlan: {
            threadId: submission.threadId,
            planId: OrchestrationProposedPlanId.make(submission.pendingAction.planId),
          },
        }
      : {}),
    createdAt: submission.createdAt,
  };
}

export function createDirectedComposerExecutor(
  dependencies: DirectedComposerSubmissionDependencies,
) {
  const commands = new Map<string, Promise<DirectedComposerSubmissionResult>>();
  return {
    submit: (submission: DirectedComposerSubmission) => {
      const recorded = commands.get(submission.commandId);
      if (recorded !== undefined) return recorded;
      const pending = submitDirectedComposer(submission, dependencies);
      commands.set(submission.commandId, pending);
      void pending.then((result) => {
        if (
          (result.kind === "provider-start-failed" || result.kind === "answer-submit-failed") &&
          commands.get(submission.commandId) === pending
        ) {
          commands.delete(submission.commandId);
        }
      });
      return pending;
    },
  };
}

const productionExecutor = createDirectedComposerExecutor({
  startTurn: async ({ environmentId, input }) =>
    (
      await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.startTurn,
        { environmentId, input },
        { reportFailure: false, reportDefect: false },
      )
    )._tag === "Success",
  answerQuestion: async ({ environmentId, input }) =>
    (
      await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.respondToUserInput,
        { environmentId, input },
        { reportFailure: false, reportDefect: false },
      )
    )._tag === "Success",
});

const titleFromPrompt = (prompt: string): string => prompt.trim().slice(0, 80) || "New thread";

export async function submitDirectedDictation(input: {
  readonly command: Extract<SymmetriaDictationCommand, { type: "dictation.deliver" }>;
  readonly reservedTarget: SymmetriaDictationTarget;
  readonly composerTarget: ComposerDictationTarget;
  readonly prompt: string;
  readonly messageId: MessageId;
  readonly submissionContext?: DirectedSubmissionContext | null;
  readonly sourceComposerTarget?: ComposerDictationTarget | null;
}): Promise<DirectedComposerSubmissionResult> {
  const threadRef =
    typeof input.composerTarget === "string"
      ? (() => {
          const session = useComposerDraftStore.getState().getDraftSession(input.composerTarget);
          return session
            ? { environmentId: session.environmentId, threadId: session.threadId }
            : null;
        })()
      : input.composerTarget;
  if (threadRef === null) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  const thread = appAtomRegistry.get(environmentThreadDetails.detailAtom(threadRef));
  const draft = useComposerDraftStore.getState().getComposerDraft(input.composerTarget);
  const draftSession =
    input.reservedTarget.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(DraftId.make(input.reservedTarget.draftId))
      : null;
  const projectRef =
    draftSession !== null
      ? { environmentId: draftSession.environmentId, projectId: draftSession.projectId }
      : thread !== null
        ? { environmentId: thread.environmentId, projectId: thread.projectId }
        : null;
  const project =
    projectRef === null ? null : appAtomRegistry.get(environmentProjects.projectAtom(projectRef));
  if (draft === null || (thread === null && draftSession === null) || project === null) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }

  const pendingUserInput = thread ? derivePendingUserInputs(thread.activities)[0] : undefined;
  const pendingApproval = thread ? derivePendingApprovals(thread.activities)[0] : undefined;
  const latestPlan = thread
    ? findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId)
    : null;
  const pendingAction: DirectedComposerPendingAction =
    input.submissionContext?.pendingAction ??
    (pendingUserInput
      ? {
          kind: "text-question",
          requestId: pendingUserInput.requestId,
          questionId: pendingUserInput.questions[0]!.id,
          questions: pendingUserInput.questions,
          draftAnswers: {},
          questionIndex: 0,
        }
      : pendingApproval
        ? { kind: "button-approval" }
        : thread?.interactionMode === "plan" && hasActionableProposedPlan(latestPlan)
          ? {
              kind: "plan-follow-up",
              planId: latestPlan!.id,
              planMarkdown: latestPlan!.planMarkdown,
            }
          : { kind: "composer" });

  const sendState = deriveComposerSendState({
    prompt: input.prompt,
    imageCount: draft.images.length,
    terminalContexts: draft.terminalContexts,
    elementContextCount:
      draft.elementContexts.length + draft.previewAnnotations.length + draft.reviewComments.length,
  });
  if (!sendState.hasSendableContent) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  const textWithTerminalContexts = appendTerminalContextsToPrompt(
    input.prompt,
    sendState.sendableTerminalContexts,
  );
  const textWithElementContexts = appendElementContextsToPrompt(
    textWithTerminalContexts,
    draft.elementContexts,
  );
  const textWithAnnotations = draft.previewAnnotations.reduce(
    (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
    textWithElementContexts,
  );
  const assembledPrompt = appendReviewCommentsToPrompt(textWithAnnotations, draft.reviewComments);
  const preparedPrompt = prepareDirectedProviderPrompt(assembledPrompt, input.submissionContext);
  if (!preparedPrompt.ok) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  const prompt = preparedPrompt.prompt;
  const attachments = await Promise.all(
    draft.images.map(async (image) => ({
      type: "image" as const,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await readFileAsDataUrl(image.file),
    })),
  );
  const selectedModel = draft.activeProvider
    ? draft.modelSelectionByProvider[draft.activeProvider]
    : undefined;
  const modelSelection = selectedModel ?? thread?.modelSelection ?? project.defaultModelSelection;
  const runtimeMode = draft.runtimeMode ?? thread?.runtimeMode ?? draftSession?.runtimeMode;
  const interactionMode =
    draft.interactionMode ?? thread?.interactionMode ?? draftSession?.interactionMode;
  if (runtimeMode === undefined || interactionMode === undefined) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }

  const shouldCreateThread = draftSession !== null && draftSession.promotedTo == null;
  if (shouldCreateThread && !hasValidDirectedWorktreeSelection(draftSession)) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  const shouldPrepareWorktree =
    shouldCreateThread &&
    draftSession.envMode === "worktree" &&
    draftSession.worktreePath === null &&
    draftSession.branch !== null;
  if (shouldCreateThread && modelSelection === null) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  const bootstrap: ThreadTurnStartBootstrap | undefined =
    shouldCreateThread || shouldPrepareWorktree
      ? {
          ...(shouldCreateThread
            ? {
                createThread: {
                  projectId: project.id,
                  title: titleFromPrompt(prompt),
                  modelSelection: modelSelection!,
                  runtimeMode,
                  interactionMode,
                  branch: draftSession.branch,
                  worktreePath: draftSession.worktreePath,
                  createdAt: draftSession.createdAt,
                },
              }
            : {}),
          ...(shouldPrepareWorktree
            ? {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: draftSession.branch!,
                  branch: buildTemporaryWorktreeBranchName(() => input.command.commandId),
                  ...(draftSession.startFromOrigin ? { startFromOrigin: true } : {}),
                },
                runSetupScript: true,
              }
            : {}),
        }
      : undefined;

  const result = await productionExecutor.submit({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    commandId: input.command.commandId,
    messageId: input.messageId,
    createdAt: input.command.createdAt,
    prompt,
    modelSelection: modelSelection ?? undefined,
    titleSeed: thread?.title ?? titleFromPrompt(prompt),
    runtimeMode,
    interactionMode,
    attachments,
    bootstrap,
    pendingAction,
  });
  if (result.kind === "turn-dispatched" || result.kind === "answer-submitted") {
    consumeDirectedComposerDraft(input.composerTarget, input.sourceComposerTarget);
  }
  return result;
}
