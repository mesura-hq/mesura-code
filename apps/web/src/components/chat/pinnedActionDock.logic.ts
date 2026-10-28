import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import type { PlanId, ProviderRequestKind, RuntimeRequestId } from "@t3tools/contracts";

/**
 * Mesura: what the pinned action dock above the composer shows, in which order, which items
 * are expanded, and what each item's X does.
 */

/** At phone width at most this many items are expanded; the rest are one line each. */
export const PHONE_DOCK_EXPANDED_LIMIT = 2;

// Keep only the newest follow-up dismissals that can still match.
const MAX_FOLLOW_UP_DISMISSALS_PER_THREAD = 20;

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
      readonly kind: "plan-follow-up";
      readonly planId: PlanId;
      readonly title: string | null;
    });

export type PinnedActionDockCloseAction =
  | { readonly type: "respond-approval"; readonly requestId: RuntimeRequestId; decision: "decline" }
  | { readonly type: "dismiss-plan-follow-up"; readonly planId: PlanId };

interface ThreadDockUnpinsRecord {
  readonly followUpPlanIds: ReadonlyArray<string>;
}

/** Dismissed plan follow-ups per scoped thread key. */
export type PinnedActionDockUnpins = Readonly<Record<string, ThreadDockUnpinsRecord>>;

export interface PinnedActionDockInput {
  readonly threadKey: string;
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
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

const EMPTY_THREAD_UNPINS: ThreadDockUnpinsRecord = { followUpPlanIds: [] };

export function readThreadDockUnpins(
  unpins: PinnedActionDockUnpins,
  threadKey: string,
): { readonly followUpPlanIds: ReadonlySet<string> } {
  const record = unpins[threadKey] ?? EMPTY_THREAD_UNPINS;
  return {
    followUpPlanIds: new Set(record.followUpPlanIds),
  };
}

export function dismissPlanFollowUp(
  unpins: PinnedActionDockUnpins,
  threadKey: string,
  planId: PlanId,
): PinnedActionDockUnpins {
  const record = unpins[threadKey] ?? EMPTY_THREAD_UNPINS;
  if (record.followUpPlanIds.includes(planId)) return unpins;
  return {
    ...unpins,
    [threadKey]: {
      followUpPlanIds: [...record.followUpPlanIds, planId].slice(
        -MAX_FOLLOW_UP_DISMISSALS_PER_THREAD,
      ),
    },
  };
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Persisted unpins as read back from storage; anything malformed reads as no unpins. */
export function parsePinnedActionDockUnpins(value: unknown): PinnedActionDockUnpins {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const unpins: Record<string, ThreadDockUnpinsRecord> = {};
  for (const [threadKey, record] of Object.entries(value)) {
    if (record === null || typeof record !== "object") continue;
    const { followUpPlanIds } = record as Record<string, unknown>;
    unpins[threadKey] = {
      followUpPlanIds: stringsOf(followUpPlanIds),
    };
  }
  return unpins;
}

const time = (iso: string) => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Pending dock actions in one thread, newest first. */
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
    case "plan-follow-up":
      return { type: "dismiss-plan-follow-up", planId: item.planId };
  }
}
