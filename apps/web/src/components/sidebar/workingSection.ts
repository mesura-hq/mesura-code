/**
 * Mesura: the sidebar's Working section sits directly under Search, as its own block outside the
 * sortable list, so the list below keeps the developer's order and drag-to-reorder. Upstream puts
 * it above Snoozed and orders the list by return time while it is on.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { Schema } from "effect";

import { getLocalStorageItem, writeLocalStorageValue } from "../../hooks/useLocalStorage";

/** Upstream's key, so each device keeps the choice it made before the section moved. */
export const WORKING_SECTION_EXPANDED_KEY = "t3code:sidebar:working-expanded";

/** One band crossing every this often, while the section is open and on screen. */
export const WORKING_SWEEP_INTERVAL_MS = 4000;

const SECTION_SELECTOR = "[data-working-section]";
const HEADER_SELECTOR = "[data-working-section-header]";
const ROW_SELECTOR = "[data-mesura-thread-key]";

function readWorkingSectionExpanded(): boolean {
  try {
    return getLocalStorageItem(WORKING_SECTION_EXPANDED_KEY, Schema.Boolean) ?? false;
  } catch {
    return false;
  }
}

/**
 * Collapsing unmounts every working row but the open thread's. A focused row that goes would drop
 * focus on the page, so the header takes it first.
 */
function moveFocusOffHiddenRow(): void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return;
  const section = focused.closest<HTMLElement>(SECTION_SELECTOR);
  const row = focused.closest<HTMLElement>(ROW_SELECTOR);
  if (section === null || row === null || row.getAttribute("aria-current") === "page") return;
  section.querySelector<HTMLElement>(HEADER_SELECTOR)?.focus();
}

/**
 * The one way the section opens or closes: its header, `sidebar.toggleWorking` and the Vim key all
 * come here. Written to storage rather than to sidebar state, because the command also runs while
 * the phone's drawer is unmounted.
 */
export function setWorkingSectionExpanded(value: boolean | ((current: boolean) => boolean)): void {
  const next = typeof value === "function" ? value(readWorkingSectionExpanded()) : value;
  if (!next) moveFocusOffHiddenRow();
  writeLocalStorageValue(WORKING_SECTION_EXPANDED_KEY, next, false, Schema.Boolean);
}

type WorkingEntryThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

/** When the thread's latest work started: its last message or its latest run, whichever is newer. */
function latestWorkStartedAt(thread: WorkingEntryThread): number {
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.latestUserAuthoredMessageAt ?? undefined) ?? 0,
    toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
  );
}

/**
 * Orders the section by when each thread started its current working period, newest first. Upstream
 * orders by the last message the developer sent, which places a run the agent started itself (a
 * woken coordinator, a scheduled task) by an older message. The start is read the first time a
 * thread shows as working and kept until it leaves, so later runs and phases never move it.
 */
export function createWorkingSectionOrder() {
  const enteredAt = new Map<string, number>();
  const keyOf = (thread: Pick<EnvironmentThreadShell, "id" | "environmentId">) =>
    `${thread.environmentId}:${thread.id}`;
  return <T extends WorkingEntryThread>(
    working: readonly T[],
    notWorking: ReadonlyArray<Pick<EnvironmentThreadShell, "id" | "environmentId">>,
  ): T[] => {
    for (const thread of notWorking) enteredAt.delete(keyOf(thread));
    const startOf = (thread: T) => {
      const key = keyOf(thread);
      const known = enteredAt.get(key);
      if (known !== undefined) return known;
      const started = latestWorkStartedAt(thread);
      enteredAt.set(key, started);
      return started;
    };
    return working.toSorted(
      (left, right) =>
        startOf(right) - startOf(left) ||
        left.id.localeCompare(right.id) ||
        left.environmentId.localeCompare(right.environmentId),
    );
  };
}
