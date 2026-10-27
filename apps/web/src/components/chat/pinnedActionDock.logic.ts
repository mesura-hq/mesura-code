import type { FactoryPlanTimelineItem } from "@t3tools/client-runtime/factory/plan-activities";
import {
  findPlanApprovals,
  resolvePlanApprovalState,
} from "@t3tools/client-runtime/factory/plan-approval";
import { summarizeFactoryPlanCard } from "@t3tools/client-runtime/factory/plan-model";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  FactoryPlanActivityPayload,
  PlanId,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";

/**
 * Mesura: what the pinned action dock above the composer shows, in which order, which items
 * are expanded, and what each item's X does. Everything that waits on the developer sits here,
 * so it stays visible whatever the timeline's scroll position.
 */

/** At phone width at most this many items are expanded; the rest are one line each. */
export const PHONE_DOCK_EXPANDED_LIMIT = 2;

/**
 * What the X on a question sends when the provider cannot take a dismissal: an explicit answer
 * through the normal respond path, so the agent is told rather than left waiting.
 */
export const DISMISSED_QUESTION_ANSWER =
  "[dismissed] The developer dismissed this question without answering. Continue without this answer, or ask again in plain text.";

// Unpins of plan files that keep presenting new digests, and of follow-ups, would grow without
// bound; the newest ones per thread are all that can still match.
const MAX_UNPINS_PER_THREAD = 20;

export interface PinnedActionDockFollowUp {
  readonly id: PlanId;
  readonly createdAt: string;
  readonly title: string | null;
}

interface DockItemBase {
  /** Unique within one dock and stable across derivations. */
  readonly key: string;
  readonly createdAt: string;
  /** The X's accessible name: the action, then the item it closes. */
  readonly closeLabel: string;
}

export type PinnedActionDockItem =
  | (DockItemBase & {
      readonly kind: "approval";
      readonly approval: ThreadPendingApproval;
      readonly title: string;
    })
  | (DockItemBase & {
      readonly kind: "question";
      readonly request: ThreadPendingUserInput;
      readonly title: string;
    })
  | (DockItemBase & {
      readonly kind: "plan";
      readonly digest: string;
      readonly planId: string;
      readonly plan: FactoryPlanActivityPayload;
      readonly title: string;
      readonly phaseCountLabel: string;
    })
  | (DockItemBase & {
      readonly kind: "plan-follow-up";
      readonly planId: PlanId;
      readonly title: string | null;
    });

export type PinnedActionDockCloseAction =
  | { readonly type: "respond-approval"; readonly requestId: RuntimeRequestId; decision: "decline" }
  | { readonly type: "dismiss-question"; readonly requestId: RuntimeRequestId }
  | {
      readonly type: "respond-question";
      readonly requestId: RuntimeRequestId;
      readonly answers: Readonly<Record<string, string>>;
    }
  | { readonly type: "unpin-plan"; readonly digest: string }
  | { readonly type: "dismiss-plan-follow-up"; readonly planId: PlanId };

interface ThreadDockUnpinsRecord {
  readonly planDigests: ReadonlyArray<string>;
  readonly followUpPlanIds: ReadonlyArray<string>;
}

/** Per scoped thread key: the plan digests unpinned and the plan follow-ups dismissed. */
export type PinnedActionDockUnpins = Readonly<Record<string, ThreadDockUnpinsRecord>>;

export interface PinnedActionDockInput {
  readonly threadKey: string;
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
  readonly factoryPlans: ReadonlyArray<FactoryPlanTimelineItem>;
  /** The thread's messages, where plan approvals are read from. */
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly planFollowUp: PinnedActionDockFollowUp | null;
  readonly unpins: PinnedActionDockUnpins;
}

const APPROVAL_LABELS: Readonly<Record<ProviderRequestKind, string>> = {
  command: "Command approval",
  "file-read": "File read approval",
  "file-change": "File change approval",
  permission: "App permission approval",
  "mcp-elicitation": "App access approval",
};

export function approvalLabel(kind: ProviderRequestKind): string {
  return APPROVAL_LABELS[kind] ?? "Approval";
}

const EMPTY_THREAD_UNPINS: ThreadDockUnpinsRecord = { planDigests: [], followUpPlanIds: [] };

export function readThreadDockUnpins(
  unpins: PinnedActionDockUnpins,
  threadKey: string,
): { readonly planDigests: ReadonlySet<string>; readonly followUpPlanIds: ReadonlySet<string> } {
  const record = unpins[threadKey] ?? EMPTY_THREAD_UNPINS;
  return {
    planDigests: new Set(record.planDigests),
    followUpPlanIds: new Set(record.followUpPlanIds),
  };
}

function addUnpin(
  unpins: PinnedActionDockUnpins,
  threadKey: string,
  field: keyof ThreadDockUnpinsRecord,
  value: string,
): PinnedActionDockUnpins {
  const record = unpins[threadKey] ?? EMPTY_THREAD_UNPINS;
  if (record[field].includes(value)) return unpins;
  return {
    ...unpins,
    [threadKey]: { ...record, [field]: [...record[field], value].slice(-MAX_UNPINS_PER_THREAD) },
  };
}

export function unpinFactoryPlan(
  unpins: PinnedActionDockUnpins,
  threadKey: string,
  digest: string,
): PinnedActionDockUnpins {
  return addUnpin(unpins, threadKey, "planDigests", digest);
}

export function dismissPlanFollowUp(
  unpins: PinnedActionDockUnpins,
  threadKey: string,
  planId: PlanId,
): PinnedActionDockUnpins {
  return addUnpin(unpins, threadKey, "followUpPlanIds", planId);
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Persisted unpins as read back from storage; anything malformed reads as no unpins. */
export function parsePinnedActionDockUnpins(value: unknown): PinnedActionDockUnpins {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const unpins: Record<string, ThreadDockUnpinsRecord> = {};
  for (const [threadKey, record] of Object.entries(value)) {
    if (record === null || typeof record !== "object") continue;
    const { planDigests, followUpPlanIds } = record as Record<string, unknown>;
    unpins[threadKey] = {
      planDigests: stringsOf(planDigests),
      followUpPlanIds: stringsOf(followUpPlanIds),
    };
  }
  return unpins;
}

const time = (iso: string) => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};

// A plan file keeps one card, anchored where it was first presented; a revision moves only its
// presentation time. So "newest" reads the presentation, and the anchor breaks ties.
const presentedLater = (left: FactoryPlanTimelineItem, right: FactoryPlanTimelineItem) =>
  time(left.plan.presentedAt) - time(right.plan.presentedAt) ||
  time(left.createdAt) - time(right.createdAt);

/** The newest plan presentation pins, and only while it is unapproved and not unpinned. */
function pinnedPlanItem(
  input: PinnedActionDockInput,
  unpinnedDigests: ReadonlySet<string>,
): PinnedActionDockItem | null {
  let newest: FactoryPlanTimelineItem | null = null;
  for (const item of input.factoryPlans) {
    if (newest === null || presentedLater(item, newest) >= 0) newest = item;
  }
  if (newest === null || unpinnedDigests.has(newest.plan.digest)) return null;
  const approval = resolvePlanApprovalState(findPlanApprovals(input.messages), newest.plan);
  if (approval.kind === "approved") return null;
  const summary = summarizeFactoryPlanCard(newest.plan);
  return {
    kind: "plan",
    key: `plan:${newest.id}`,
    createdAt: newest.plan.presentedAt,
    closeLabel: `Unpin plan: ${summary.title}`,
    digest: newest.plan.digest,
    planId: newest.id,
    plan: newest.plan,
    title: summary.title,
    phaseCountLabel: summary.phaseCountLabel,
  };
}

function questionTitle(request: ThreadPendingUserInput): string {
  const first = request.questions[0];
  if (first === undefined) return "Question from the agent";
  const line = first.question.split(/\r?\n/, 1)[0]!.trim();
  return request.questions.length > 1 ? `${line} (+${request.questions.length - 1} more)` : line;
}

/** Everything that waits on the developer in one thread, newest first. */
export function derivePinnedActionDockItems(
  input: PinnedActionDockInput,
): ReadonlyArray<PinnedActionDockItem> {
  const unpins = readThreadDockUnpins(input.unpins, input.threadKey);
  const items: PinnedActionDockItem[] = [];
  for (const approval of input.approvals) {
    const title = approvalLabel(approval.requestKind);
    items.push({
      kind: "approval",
      key: `approval:${approval.requestId}`,
      createdAt: approval.createdAt,
      closeLabel: `Decline ${title.toLowerCase()}${approval.detail ? `: ${approval.detail}` : ""}`,
      approval,
      title,
    });
  }
  for (const request of input.userInputs) {
    const title = questionTitle(request);
    items.push({
      kind: "question",
      key: `question:${request.requestId}`,
      createdAt: request.createdAt,
      closeLabel: `Dismiss question: ${title}`,
      request,
      title,
    });
  }
  const plan = pinnedPlanItem(input, unpins.planDigests);
  if (plan !== null) items.push(plan);
  const followUp = input.planFollowUp;
  if (followUp !== null && !unpins.followUpPlanIds.has(followUp.id)) {
    items.push({
      kind: "plan-follow-up",
      key: `plan-follow-up:${followUp.id}`,
      createdAt: followUp.createdAt,
      closeLabel: followUp.title
        ? `Dismiss plan follow-up: ${followUp.title}`
        : "Dismiss plan follow-up",
      planId: followUp.id,
      title: followUp.title,
    });
  }
  // Stable for equal times, so items created together keep the order above.
  return items.sort((left, right) => time(right.createdAt) - time(left.createdAt));
}

/**
 * Which items show expanded. Desktop expands all of them; phone width expands at most
 * `PHONE_DOCK_EXPANDED_LIMIT`, the ones the developer tapped first, then the newest.
 */
export function layoutPinnedActionDock(
  items: ReadonlyArray<PinnedActionDockItem>,
  options: { readonly phoneWidth: boolean; readonly expandedKeys: ReadonlySet<string> },
): ReadonlyArray<{ readonly item: PinnedActionDockItem; readonly expanded: boolean }> {
  if (!options.phoneWidth) return items.map((item) => ({ item, expanded: true }));
  const expanded = new Set<string>();
  for (const item of items) {
    if (expanded.size < PHONE_DOCK_EXPANDED_LIMIT && options.expandedKeys.has(item.key))
      expanded.add(item.key);
  }
  for (const item of items) {
    if (expanded.size < PHONE_DOCK_EXPANDED_LIMIT) expanded.add(item.key);
  }
  return items.map((item) => ({ item, expanded: expanded.has(item.key) }));
}

export function pinnedActionDockCloseAction(
  item: PinnedActionDockItem,
): PinnedActionDockCloseAction {
  switch (item.kind) {
    case "approval":
      return { type: "respond-approval", requestId: item.approval.requestId, decision: "decline" };
    case "question":
      return item.request.dismissible
        ? { type: "dismiss-question", requestId: item.request.requestId }
        : {
            type: "respond-question",
            requestId: item.request.requestId,
            answers: Object.fromEntries(
              item.request.questions.map((question) => [question.id, DISMISSED_QUESTION_ANSWER]),
            ),
          };
    case "plan":
      return { type: "unpin-plan", digest: item.digest };
    case "plan-follow-up":
      return { type: "dismiss-plan-follow-up", planId: item.planId };
  }
}
