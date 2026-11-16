import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderRequestKind, RuntimeRequestId } from "@t3tools/contracts";

/**
 * Mesura: what the pinned action dock above the composer shows, in which order, which items
 * are expanded, and what each item's X does.
 */

/** At phone width at most this many items are expanded; the rest are one line each. */
export const PHONE_DOCK_EXPANDED_LIMIT = 2;

interface DockItemBase {
  /** Unique within one dock and stable across derivations. */
  readonly key: string;
  readonly createdAt: string;
  /** The X's accessible name: the action, then the item it closes. */
  readonly closeLabel: string;
}

export type PinnedActionDockItem = DockItemBase & {
  readonly kind: "approval";
  readonly approval: ThreadPendingApproval;
  readonly title: string;
};

export interface PinnedActionDockCloseAction {
  readonly type: "respond-approval";
  readonly requestId: RuntimeRequestId;
  readonly decision: "decline";
}

export interface PinnedActionDockInput {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
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

const time = (iso: string) => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Pending dock actions in one thread, newest first. */
export function derivePinnedActionDockItems(
  input: PinnedActionDockInput,
): ReadonlyArray<PinnedActionDockItem> {
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
  // Stable for equal times, so items created together keep their input order.
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
  return { type: "respond-approval", requestId: item.approval.requestId, decision: "decline" };
}
