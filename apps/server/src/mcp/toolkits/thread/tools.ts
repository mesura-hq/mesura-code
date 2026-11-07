import {
  DraftReviewDefinition,
  OrchestratorMcpEnvironmentTarget,
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchMatch,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  THREAD_AGENT_SIGNAL_NOTE_MAX_LENGTH,
  ThreadAgentSignalNote,
  ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
// Mesura: the compact-then-continue tool's schemas and the live session it checks.
import * as CompactAndContinue from "../../../orchestration-v2/CompactAndContinue.ts";
import * as ProviderSessionManager from "../../../orchestration-v2/ProviderSessionManager.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark a thread unread. Omit `threadId` for this thread. `snooze` needs `snoozedUntil`. Settling this thread applies at turn end. A failed turn or queued message leaves it active.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
  }),
  success: Schema.Union([
    OrchestrationV2DispatchCommandResult,
    Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, true);

// Mesura: the agent's needs-input / ready-to-close mark.
const ThreadSignalTool = Tool.make("t3_thread_signal", {
  description: `Mark a thread for the user. needs_input: you are ending your turn with a question or a decision only the user can make. Call it before your final reply and put the question in that reply, not before this call. ready_to_close: call it only when you judge that the thread's purpose (the goal the user gave this thread) is fulfilled and no background command, subagent, delegated task, or watch is still running. Do not call it just because a turn or one step ended. The user may give the thread a new purpose afterwards. clear: remove the mark. note is the question in at most ${THREAD_AGENT_SIGNAL_NOTE_MAX_LENGTH} characters. Omit threadId for this thread. The user's next message clears the mark, a new turn clears ready_to_close, and settling clears both.`,
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    state: Schema.Literals(["needs_input", "ready_to_close", "clear"]),
    note: Schema.optional(ThreadAgentSignalNote),
  }),
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
}).annotate(Tool.Title, "Signal the user");

// Mesura: the agent queues /compact and the user's next request on its own thread.
const ThreadCompactAndContinueTool = Tool.make("t3_thread_compact_and_continue", {
  description:
    "Queue a context compaction of this thread, then a follow-up message with the user's next request, both to run after your turn ends. Call it only when the user's latest message asks you to compact, and only after you finished and verified the requested work; if the work failed or is incomplete, do not call it and tell the user instead. Put the user's next request in `next`, quoted as they wrote it, and in `handoff` what you must keep after compaction (decisions, state, paths, results). After calling it, end your turn with a one-line reply.",
  parameters: Schema.Struct({
    next: CompactAndContinue.CompactAndContinueNext,
    handoff: Schema.optional(CompactAndContinue.CompactAndContinueHandoff),
  }),
  success: CompactAndContinue.CompactAndContinueResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderSessionManager.ProviderSessionManagerV2,
  ],
}).annotate(Tool.Title, "Compact, then continue");

const queueTarget = {
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: Schema.optional(ThreadId),
  queuedRunId: RunId,
};
const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QueueListTool = Tool.make("t3_queue_list", {
  ...commandTool,
  description: "List queued messages in send order. For full history, use `t3_thread_read`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueReadTool = Tool.make("t3_queue_read", {
  ...commandTool,
  description: "Read up to 16,000 chars of one queued message. Omit `threadId` for this thread.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueEditTool = Tool.make("t3_queue_edit", {
  ...commandTool,
  description:
    "Replace one queued message's text. Attachments stay. Fails if the run is no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, true);
const QueueCancelTool = Tool.make("t3_queue_cancel", {
  ...commandTool,
  description: "Cancel one queued run.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
const QueueReorderTool = Tool.make("t3_queue_reorder", {
  ...commandTool,
  description: "Move one queued run before another, or to the end with `beforeRunId=null`.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, true);
const QueuePromoteTool = Tool.make("t3_queue_promote_to_steer", {
  ...commandTool,
  description: "Send one queued message now as steering to the given active run.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotate(Tool.Destructive, true);

const requestTarget = {
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: Schema.optional(ThreadId),
  requestId: RuntimeRequestId,
};
const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
const pendingRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(question),
});
const PendingRequestListTool = Tool.make("t3_pending_request_list", {
  ...commandTool,
  description:
    "List pending user questions in a thread. Omit `threadId` for this thread. Approvals are not listed.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("t3_pending_request_read", {
  ...commandTool,
  description: "Read one pending user question. Answer it with `t3_pending_request_respond`.",
  parameters: Schema.Struct(requestTarget),
  success: pendingRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("t3_pending_request_respond", {
  ...commandTool,
  description: "Answer one pending user question. This cannot approve a permission request.",
  parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadConfigurationTool = Tool.make("t3_thread_configuration", {
  ...commandTool,
  description: "Read a thread's provider, model, and modes. Omit `threadId` for this thread.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Set a thread's provider, model, and options. Omit `threadId` for this thread. Permission modes stay. Values from `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, true);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("t3_thread_fork", {
  ...commandTool,
  description:
    "Fork a thread from a stable run or checkpoint. Omit `threadId` for this thread. Keeps source setup. No turn has run yet.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadMergeBackTool = Tool.make("t3_thread_merge_back", {
  ...commandTool,
  description:
    "Merge context from one thread into a related thread in the same project. Omit `sourceThreadId` for this thread.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    sourceThreadId: Schema.optional(ThreadId),
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadTransfersTool = Tool.make("t3_thread_transfers", {
  ...commandTool,
  description: "Read context transfer status for a thread. Omit `threadId` for this thread.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({
    transfers: Schema.Array(
      Schema.Struct({
        id: OrchestrationV2ContextTransfer.fields.id,
        sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
        targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
        status: OrchestrationV2ContextTransfer.fields.status,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search active threads by title, branch, PR, project, then message text. Skips subagent threads. `projectId`: one project, else yours, else all outside a thread. Not exhaustive.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({
        threadId: OrchestrationThreadSearchMatch.fields.threadId,
        projectId: OrchestrationThreadSearchMatch.fields.projectId,
        title: Schema.String,
        link: Schema.optional(Schema.String),
        source: Schema.Literals(["title", "user", "assistant"]),
        snippet: Schema.optional(OrchestrationThreadSearchMatch.fields.snippet),
        messageCreatedAt: Schema.optional(OrchestrationThreadSearchMatch.fields.messageCreatedAt),
      }),
    ),
  }),
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run one scheduled task now. Needs a full-access or default caller. Returns its thread, or null if not started. Success means started, not finished.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    taskId: ScheduledTaskId,
  }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const DraftReviewTool = Tool.make("t3_draft_review", {
  ...commandTool,
  description:
    "Present an editable draft at the bottom of the chat. Use channel email, whatsapp, slack, or any custom channel. Fields describe editable metadata (recipient, subject, chat, workspace, channel). Returns immediately. Wait for the user's confirmation message before continuing with the draft. Confirmation supplies the exact edited text; it does not send or publish it or grant permission to do so. Reuse requestKey only to retry the same draft. Never answer this request yourself.",
  success: Schema.Struct({ sequence: NonNegativeInt, requestId: RuntimeRequestId }),
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    requestKey: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    draft: DraftReviewDefinition,
  }),
});

export const ThreadToolkit = Toolkit.make(
  DraftReviewTool,
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadForkTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
  ThreadConfigurationTool,
  ThreadConfigureTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  ThreadOrganizeTool,
  ThreadSignalTool,
  // Mesura: compact this thread, then continue.
  ThreadCompactAndContinueTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
);
