import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  parseCodexFeedbackCommand,
  type submitCodexFeedback,
} from "@t3tools/client-runtime/state/threads";
import { dictatedMessageText } from "@t3tools/client-runtime/dictation";
import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ScopedThreadRef,
  type ServerConfig,
} from "@t3tools/contracts";
import { countPendingDictationSlots } from "@t3tools/shared/dictationSlots";
import { Alert } from "react-native";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { composerContextSendBlockReason } from "../lib/composerContext";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { scopedThreadKey } from "../lib/scopedEntities";
import { resolveProviderInteractionMode } from "../features/threads/legacy-plan-mode";
import { appAtomRegistry } from "./atom-registry";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "./composer-attachment-uploads";
import { armDictationDraft, forgetDictationDraft, isDictationDraftVoiced } from "./dictationDrafts";
import { serverEnvironment } from "./server";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { environmentThreadShells } from "./threads";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContent,
  composerContextImportsAtom,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  scheduleUnusedComposerAttachmentCleanup,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "./use-remote-environment-registry";

/** What the thread screen knows about a send that the stores alone do not. */
export interface ComposerSendContext {
  readonly thread: Pick<
    EnvironmentThreadShell,
    "modelSelection" | "runtimeMode" | "interactionMode" | "session"
  >;
  /** The server has not created this thread yet. */
  readonly creationPending: boolean;
  readonly connected: boolean;
  readonly serverConfig: ServerConfig | null;
  /** Codex `/feedback` reports into the screen's own list, so only the screen can send it. */
  readonly submitCodexFeedback?: (input: {
    readonly command: NonNullable<ReturnType<typeof parseCodexFeedbackCommand>>;
    readonly submission: Parameters<typeof submitCodexFeedback>[0]["submission"];
  }) => Promise<void>;
}

/**
 * Off screen, a send is set off by a dictation job the server just completed, so the
 * environment is connected; the thread and its server config come from the stores.
 */
function readOffScreenSendContext(ref: ScopedThreadRef): ComposerSendContext | null {
  const thread = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
  if (!thread) return null;
  return {
    thread,
    creationPending: false,
    connected: true,
    serverConfig: appAtomRegistry.get(serverEnvironment.configValueAtom(ref.environmentId)),
  };
}

/**
 * Sends a thread's composer draft through the outbox, whether or not its composer is on screen:
 * the thread screen passes what it knows, and a dictated draft that fills while the user is
 * elsewhere reads the rest from the stores. A dictated draft goes with one `[voiced] ` tag.
 */
export async function sendComposerDraftToThread(
  ref: ScopedThreadRef,
  screen?: ComposerSendContext,
): Promise<MessageId | null> {
  const context = screen ?? readOffScreenSendContext(ref);
  if (!context) return null;
  // The server has not created this thread yet. Queuing a follow-up against
  // its id would strand the message: if the creation is rejected the thread
  // never appears and the drain drops the orphan. The composer disables its
  // send button too; this guard also covers the editor's submit key.
  if (context.creationPending) {
    return null;
  }

  const threadKey = scopedThreadKey(ref.environmentId, ref.threadId);
  const draft = getComposerDraftSnapshot(threadKey);
  if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) return null;
  const { thread, serverConfig } = context;
  const text = draft.text.trim();
  const attachments = draft.attachments;
  if (
    composerAttachmentUploadBlockReason({
      environmentId: ref.environmentId,
      attachments,
      connected: context.connected,
      serverConfig,
      states: appAtomRegistry.get(composerAttachmentUploadsAtom),
    }) !== null
  )
    return null;
  if (text.length === 0 && attachments.length === 0) {
    return null;
  }
  // A transcription is still pending: Send never goes out with a marker in it. It arms the draft,
  // which then sends itself once its last marker fills, as on web.
  if (countPendingDictationSlots(draft.text) > 0) {
    armDictationDraft(threadKey);
    return null;
  }
  // A send-failure restore appends with allowOverflow so it never drops the
  // user's files, which can leave the draft over the cap. Sending it anyway
  // would enqueue a message that outbox recovery rejects forever, so block
  // here until the user removes attachments.
  if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    Alert.alert(
      "Too many attachments",
      `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
    );
    return null;
  }

  const contextBlockReason = composerContextSendBlockReason(draft.context);
  if (contextBlockReason) {
    Alert.alert("Too much context", contextBlockReason);
    return null;
  }

  const modelSelection = draft.modelSelection ?? thread.modelSelection;
  if (context.connected && isModelSelectionUnavailable(serverConfig, modelSelection)) {
    Alert.alert(
      "Antigravity model unavailable",
      "Set up Antigravity on web or desktop, or choose another model.",
    );
    return null;
  }
  const provider = serverConfig?.providers.find(
    (entry) => entry.instanceId === modelSelection.instanceId,
  );
  const feedbackCommand =
    attachments.length === 0 &&
    (provider?.driver === "codex" || thread.session?.providerName === "codex")
      ? parseCodexFeedbackCommand(text)
      : null;
  if (feedbackCommand) {
    if (thread.session === null) {
      Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
      return null;
    }
    if (!context.submitCodexFeedback) return null;
    const metadata = makeQueuedMessageMetadata();
    await context.submitCodexFeedback({
      command: feedbackCommand,
      submission: {
        id: MessageId.make(metadata.messageId),
        command: text,
        createdAt: metadata.createdAt,
      },
    });
    return null;
  }

  const metadata = makeQueuedMessageMetadata();
  const messageId = MessageId.make(metadata.messageId);
  // Enqueue publishes the queued atom synchronously (the durable write
  // happens behind it), so clearing the draft here gives send feedback on
  // the tap frame instead of after file I/O. If the write fails the message
  // is rolled out of the queue and the content is merged back into the
  // draft, preserving anything typed since.
  const enqueuePromise = enqueueThreadOutboxMessage({
    environmentId: ref.environmentId,
    threadId: ref.threadId,
    messageId,
    commandId: CommandId.make(metadata.commandId),
    text: dictatedMessageText(text, isDictationDraftVoiced(threadKey)),
    attachments,
    context: draft.context,
    modelSelection,
    runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
    interactionMode: resolveProviderInteractionMode(
      provider,
      draft.interactionMode ?? thread.interactionMode,
    ),
    createdAt: metadata.createdAt,
  });
  clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
  forgetDictationDraft(threadKey);
  enqueuePromise.then(
    () => {
      // The queued message owns the files now; the sweep sees that and
      // spares them. Deferred to here so a failed write cannot roll the
      // message out of the queue mid-sweep and lose the bytes.
      scheduleUnusedComposerAttachmentCleanup(attachments);
    },
    (error: unknown) => {
      // Restore text via merge (idempotent) but attachments via the uncapped
      // append: the merge path slots existing attachments first and truncates
      // at the send limit, which would silently drop this message's images if
      // the user attached new ones while the write was in flight.
      void mergeComposerDraftContent(threadKey, {
        text,
        context: draft.context,
        attachments: [],
      });
      appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    },
  );
  return messageId;
}
