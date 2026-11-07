import { useEffect, useRef } from "react";
import {
  RuntimeRequestId,
  type DraftReviewDefinition,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { MailIcon } from "lucide-react";
import { DraftReviewCard, type ReviewDraftText } from "./DraftReviewCard";
import { SlackDraftIcon, WhatsAppDraftIcon } from "./DraftChannelIcons";
import type { InlinePendingUserInputContext } from "./InlinePendingUserInputCard";
import type { PendingUserInput } from "../../session-logic";
import {
  EMPTY_QUESTION_ANSWERS,
  pendingUserInputRequestKey,
  usePendingUserInputDraftStore,
} from "../../pendingUserInputDraftStore";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { newCommandId } from "../../lib/utils";

const channelLabels = new Map([
  ["email", "Correo"],
  ["whatsapp", "WhatsApp"],
  ["slack", "Slack"],
  ["text", "Texto libre"],
]);
function presentation(draft: DraftReviewDefinition) {
  return {
    label: draft.channelLabel ?? channelLabels.get(draft.channel) ?? draft.channel,
    icon:
      draft.channel === "email" ? (
        <MailIcon className="size-4" />
      ) : draft.channel === "slack" ? (
        <SlackDraftIcon className="size-4" />
      ) : draft.channel === "whatsapp" ? (
        <WhatsAppDraftIcon className="size-4" />
      ) : undefined,
    fields: draft.fields,
  };
}
function originalText(draft: DraftReviewDefinition): ReviewDraftText {
  return {
    body: draft.body,
    fields: Object.fromEntries(draft.fields.map((field) => [field.id, field.value])),
  };
}

export function PendingDraftReviewCard({
  request,
  context,
}: {
  request: PendingUserInput & { draftReview: DraftReviewDefinition };
  context: InlinePendingUserInputContext;
}) {
  const dispatch = useOrchestrationCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const key = pendingUserInputRequestKey(
    context.environmentId,
    context.threadId,
    request.requestId,
  );
  const answers = usePendingUserInputDraftStore(
    (state) => state.requests[key]?.answers ?? EMPTY_QUESTION_ANSWERS,
  );
  const container = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- handles the timeline's imperative focus request after a virtualized card mounts
  useEffect(() => {
    if (context.focusRequestId !== request.requestId || context.unavailable) return;
    const field = container.current?.querySelector("textarea");
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: "nearest" });
    context.onQuestionFocused?.();
  }, [context, request.requestId]);
  const draft = request.draftReview;
  const original = originalText(draft);
  const value = {
    body: answers.body?.customAnswer ?? original.body,
    fields: Object.fromEntries(
      draft.fields.map((field) => [
        field.id,
        answers[`field:${field.id}`]?.customAnswer ?? field.value,
      ]),
    ),
  };
  const reply = {
    body: value.body,
    ...Object.fromEntries(
      draft.fields.map((field) => [`field:${field.id}`, value.fields[field.id] ?? ""]),
    ),
  };
  const onChange = (next: ReviewDraftText) => {
    const store = usePendingUserInputDraftStore.getState();
    for (const question of request.questions) {
      const text = question.id === "body" ? next.body : (next.fields[question.id.slice(6)] ?? "");
      const current = question.id === "body" ? value.body : value.fields[question.id.slice(6)];
      if (text !== current) store.update(key, question, { text });
    }
  };
  return (
    <div ref={container} data-pending-user-input-request-id={request.requestId}>
      <DraftReviewCard
        title={draft.title}
        presentation={presentation(draft)}
        original={original}
        value={value}
        status="pending"
        unavailable={
          context.unavailable ||
          request.responseCapability === "not_resumable" ||
          context.respondingRequestIds.includes(request.requestId)
        }
        onChange={onChange}
        onConfirm={async () => {
          if (!(await context.onRespond(request.requestId, reply)))
            throw new Error("Draft delivery failed.");
        }}
        onDismiss={async () => {
          const result = await dispatch({
            environmentId: context.environmentId,
            input: {
              type: "runtime-request.respond",
              commandId: newCommandId(),
              threadId: context.threadId,
              requestId: request.requestId,
              decision: "cancel",
              answers: reply,
            },
          });
          if (result._tag !== "Success") throw new Error("Draft dismissal failed.");
        }}
        onReopen={() => {}}
      />
    </div>
  );
}

export function DraftReviewHistoryCard({
  item,
  context,
  visibility,
}: {
  item: Extract<OrchestrationV2TurnItem, { type: "user_input_request" }> & {
    draftReview: DraftReviewDefinition;
  };
  context: InlinePendingUserInputContext;
  visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const dispatch = useOrchestrationCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  // Inherited history belongs to another thread. Reopening it would mutate its source.
  const canReopen = visibility === "local" && item.threadId === context.threadId;
  const original = originalText(item.draftReview);
  const answers = item.questionAnswer?.answers;
  const value = answers
    ? {
        body: typeof answers.body === "string" ? answers.body : original.body,
        fields: Object.fromEntries(
          item.draftReview.fields.map((field) => [
            field.id,
            typeof answers[`field:${field.id}`] === "string"
              ? (answers[`field:${field.id}`] as string)
              : field.value,
          ]),
        ),
      }
    : original;
  return (
    <DraftReviewCard
      title={item.draftReview.title}
      presentation={presentation(item.draftReview)}
      original={original}
      value={value}
      status={item.status === "completed" ? "confirmed" : "dismissed"}
      unavailable={context.unavailable}
      readOnly={!canReopen}
      revised={item.draftReviewRevisedBy !== undefined}
      onChange={() => {}}
      onConfirm={async () => {}}
      onDismiss={() => {}}
      onReopen={async () => {
        if (!canReopen) return;
        const result = await dispatch({
          environmentId: context.environmentId,
          input: {
            type: "draft-review.reopen",
            commandId: newCommandId(),
            threadId: context.threadId,
            requestId: item.requestId,
          },
        });
        if (result._tag !== "Success") throw new Error("Draft reopen failed.");
        context.onDraftReopened?.(RuntimeRequestId.make(`${item.requestId}:revision`));
      }}
    />
  );
}
