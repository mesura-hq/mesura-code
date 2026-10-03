import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import {
  OrchestrationProposedPlanId,
  type CommandId,
  type DictationTarget,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
  type ThreadTurnStartBootstrap,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

import { useComposerDraftStore, DraftId, type DraftSessionState } from "../composerDraftStore";
import { deriveComposerSendState, readFileAsDataUrl } from "../components/ChatView.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { buildMessageContext } from "../lib/composerContextRecords";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { environmentServerConfigsAtom } from "../state/server";
import { findLatestProposedPlan, hasActionableProposedPlan } from "../session-logic";
import { resolvePlanFollowUpSubmission } from "../proposedPlan";
import {
  formatOutgoingComposerPrompt,
  getComposerPromptLengthValidationMessage,
} from "../components/chat/composerSubmission";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import type { ComposerDictationTarget } from "./dictationTarget";

export type DirectedComposerPendingAction =
  | { readonly kind: "composer" }
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
  /**
   * Terminal picks, review comments and preview annotations that travel with
   * the message, and whether this server takes them inline. A server from
   * before inline context drops the records, so for those the same content is
   * serialized into the text instead.
   */
  readonly messageContext?:
    | {
        readonly inline: boolean;
        readonly context: OrchestrationMessageContext | undefined;
      }
    | undefined;
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
  /** The user changed the draft while its uploads finished; nothing was sent or consumed. */
  | { readonly kind: "draft-changed" }
  | { readonly kind: "provider-start-failed"; readonly messageId: MessageId }
  | { readonly kind: "refused"; readonly code: "unsupported_composer_action" };

type DirectedComposerDraft = NonNullable<
  ReturnType<ReturnType<typeof useComposerDraftStore.getState>["getComposerDraft"]>
>;

const draftAttachmentIds = (draft: DirectedComposerDraft) =>
  [...draft.images, ...draft.files].map((attachment) => attachment.id).join("\n");

/**
 * Puts a draft that failed to send back, ahead of anything the user wrote into the emptied
 * composer while the send was in flight, so neither is lost.
 */
function restoreDirectedComposerDraft(
  target: ComposerDictationTarget,
  sent: DirectedComposerDraft,
): void {
  const store = useComposerDraftStore.getState();
  const typed = store.getComposerDraft(target);
  const typedPrompt = typed?.prompt ?? "";
  store.setPrompt(
    target,
    typedPrompt.trim() === "" ? sent.prompt : `${sent.prompt.trimEnd()}\n${typedPrompt}`,
  );
  if (sent.images.length > 0) store.addImages(target, [...sent.images]);
  if (sent.files.length > 0) store.addFiles(target, [...sent.files]);
  store.setTerminalContexts(target, [...sent.terminalContexts, ...(typed?.terminalContexts ?? [])]);
  store.setPreviewAnnotations(target, [
    ...sent.previewAnnotations,
    ...(typed?.previewAnnotations ?? []),
  ]);
  store.setReviewComments(target, [...sent.reviewComments, ...(typed?.reviewComments ?? [])]);
}

export type DirectedComposerSubmissionDependencies = {
  readonly startTurn: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: StartThreadTurnInput;
  }) => Promise<boolean>;
};

async function submitDirectedComposer(
  submission: DirectedComposerSubmission,
  dependencies: DirectedComposerSubmissionDependencies,
): Promise<DirectedComposerSubmissionResult> {
  if (submission.pendingAction.kind === "button-approval") {
    return { kind: "refused", code: "unsupported_composer_action" };
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
  const messageContext = submission.messageContext;
  // The legacy text is built from `text`, not from the raw prompt: a plan
  // follow-up rewrites the message, and serializing the prompt would send the
  // pre-rewrite words to exactly the servers that cannot read the records.
  const contextFields =
    messageContext === undefined
      ? {}
      : messageContext.inline
        ? messageContext.context
          ? { context: messageContext.context }
          : {}
        : {
            text: serializeLegacyContextMessage({
              text,
              records: messageContext.context?.records ?? [],
            }),
          };
  return {
    commandId: submission.commandId,
    threadId: submission.threadId,
    message: {
      messageId: submission.messageId,
      role: "user",
      text,
      attachments: [...submission.attachments],
      ...contextFields,
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
          result.kind === "provider-start-failed" &&
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
});

const titleFromPrompt = (prompt: string): string => prompt.trim().slice(0, 80) || "New thread";

export async function submitDirectedDictation(input: {
  /** Identifies the send: a repeat with the same `commandId` starts no second turn. */
  readonly command: { readonly commandId: CommandId; readonly createdAt: string };
  readonly target: Exclude<DictationTarget, null>;
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
    input.target.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(DraftId.make(input.target.draftId))
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

  const pendingRequests = thread ? derivePendingRequests(thread.activities) : null;
  const pendingApproval = pendingRequests?.approvals[0];
  const latestPlan = thread
    ? findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId)
    : null;
  const pendingAction: DirectedComposerPendingAction =
    input.submissionContext?.pendingAction ??
    (pendingApproval
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
    imageCount: draft.images.length + draft.files.length,
    terminalContexts: draft.terminalContexts,
    elementContextCount: draft.previewAnnotations.length + draft.reviewComments.length,
  });
  if (!sendState.hasSendableContent) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  const preparedPrompt = prepareDirectedProviderPrompt(input.prompt, input.submissionContext);
  if (!preparedPrompt.ok) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  const prompt = preparedPrompt.prompt;
  // A file travels only as an upload, as in the composer's own send: finish (or verify) each
  // upload first, and refuse rather than drop a file that cannot be uploaded.
  for (const file of draft.files) {
    startAttachmentUpload({
      environmentId: threadRef.environmentId,
      image: file,
      draftTarget: input.composerTarget,
    });
  }
  await awaitAttachmentUploads(draft.files.map((file) => file.id));
  const files = getUploadedAttachments({
    environmentId: threadRef.environmentId,
    images: draft.files,
  });
  if (files === null) {
    return { kind: "refused", code: "unsupported_composer_action" };
  }
  const images = await Promise.all(
    draft.images.map(async (image) => ({
      type: "image" as const,
      // The local id is the wire id on the data-URL path, so its context record binds to it.
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await readFileAsDataUrl(image.file),
    })),
  );
  const attachments = [...images, ...files];
  // v0.0.42 stopped appending this material to the prompt as text. It travels
  // as records beside the message now, and only a server too old to read them
  // gets the serialized form — which `buildDirectedTurnStartInput` decides.
  // Built after the uploads: a file's record binds to the id its upload got on the wire.
  const messageContext = buildMessageContext({
    terminalContexts: sendState.sendableTerminalContexts,
    reviewComments: draft.reviewComments,
    previewAnnotations: draft.previewAnnotations,
    attachments: [
      ...draft.images.map((image) => ({ attachment: image, attachmentId: image.id })),
      ...draft.files.map((file, index) => ({ attachment: file, attachmentId: files[index]!.id })),
    ],
  });
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

  // The draft is consumed before the turn is acknowledged, as the composer's own send does, so
  // what the user writes meanwhile is a new draft and survives. A failed send puts it back.
  const latest = useComposerDraftStore.getState().getComposerDraft(input.composerTarget);
  if (
    latest === null ||
    latest.prompt !== draft.prompt ||
    draftAttachmentIds(latest) !== draftAttachmentIds(draft)
  ) {
    return { kind: "draft-changed" };
  }
  consumeDirectedComposerDraft(input.composerTarget, input.sourceComposerTarget);
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
    messageContext: {
      inline:
        appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId)?.environment
          .capabilities.inlineMessageContext === true,
      context: messageContext,
    },
  });
  if (result.kind !== "turn-dispatched") restoreDirectedComposerDraft(input.composerTarget, draft);
  return result;
}
