/**
 * Mesura: the agent search popup's state (docs/mesura/adr-010-search-chats.md).
 * A search is an ordinary thread in the hidden search project; this holds only
 * what the client adds on top: whether the popup is open, which search it
 * shows, and which finished search the developer has not looked at yet.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  THREAD_SEARCH_PROJECT_ID,
  type EnvironmentId,
  type OrchestrationV2RunStatus,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

export interface AgentSearchPopupState {
  readonly open: boolean;
  readonly activeSearch: ScopedThreadRef | null;
  readonly unseenResult: ScopedThreadRef | null;
}

export type AgentSearchPopupAction =
  | { readonly type: "open"; readonly search?: ScopedThreadRef }
  | { readonly type: "close" }
  | { readonly type: "select"; readonly search: ScopedThreadRef }
  | { readonly type: "settled"; readonly search: ScopedThreadRef }
  | { readonly type: "deleted"; readonly search: ScopedThreadRef };

export const initialAgentSearchPopupState: AgentSearchPopupState = {
  open: false,
  activeSearch: null,
  unseenResult: null,
};

export function sameSearch(a: ScopedThreadRef | null, b: ScopedThreadRef | null): boolean {
  return (
    a !== null && b !== null && a.environmentId === b.environmentId && a.threadId === b.threadId
  );
}

/** Showing a search in the open popup is what makes its result seen. */
function showing(
  state: AgentSearchPopupState,
  activeSearch: ScopedThreadRef | null,
): AgentSearchPopupState {
  return {
    open: true,
    activeSearch,
    unseenResult: sameSearch(state.unseenResult, activeSearch) ? null : state.unseenResult,
  };
}

export function reduceAgentSearchPopup(
  state: AgentSearchPopupState,
  action: AgentSearchPopupAction,
): AgentSearchPopupState {
  switch (action.type) {
    case "open":
      return showing(state, action.search ?? state.activeSearch);
    case "close":
      return state.open ? { ...state, open: false } : state;
    case "select":
      return showing(state, action.search);
    case "settled":
      return state.open && sameSearch(state.activeSearch, action.search)
        ? state
        : { ...state, unseenResult: action.search };
    case "deleted":
      return {
        ...state,
        activeSearch: sameSearch(state.activeSearch, action.search) ? null : state.activeSearch,
        unseenResult: sameSearch(state.unseenResult, action.search) ? null : state.unseenResult,
      };
  }
}

export function isSearchThread(thread: Pick<EnvironmentThreadShell, "projectId">): boolean {
  return thread.projectId === THREAD_SEARCH_PROJECT_ID;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** The search's latest run, and whether it has yet to reach a terminal state. */
export interface SearchRun {
  readonly runId: RunId;
  readonly active: boolean;
}

export function searchRunOf(thread: Pick<EnvironmentThreadShell, "latestRun">): SearchRun | null {
  const run = thread.latestRun;
  return run === null ? null : { runId: run.runId, active: ACTIVE_RUN_STATUSES.has(run.status) };
}

/**
 * A search runs until its run reaches a terminal state. A run that waits for
 * an approval or an answer is still running: the sidebar's attention labels
 * are not the run's state.
 */
export function isSearchRunning(thread: Pick<EnvironmentThreadShell, "latestRun">): boolean {
  return searchRunOf(thread)?.active ?? false;
}

/** The run that was active reached a terminal state: the search ended. */
export function searchSettled(before: SearchRun | null, now: SearchRun | null): boolean {
  return (
    before !== null && before.active && now !== null && now.runId === before.runId && !now.active
  );
}

/** Earlier searches: the search project's threads, newest first. */
export function selectSearchHistory<T extends EnvironmentThreadShell>(
  threads: ReadonlyArray<T>,
): T[] {
  return threads
    .filter(isSearchThread)
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function shouldShowAgentSearchSparkle(input: {
  readonly query: string;
  readonly unseenResult: ScopedThreadRef | null;
}): boolean {
  return input.query.trim().length > 0 || input.unseenResult !== null;
}

/**
 * The sidebar Search's keys that belong to the agent search: Tab in a non-empty field hands its
 * text to a new search, and Escape while the popup is open closes it (focus can still sit in the
 * field just after Tab). Returns whether the key was the agent search's.
 */
export function routeAgentSearchFieldKey(
  event: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly preventDefault: () => void;
  },
  query: string,
  /** `start` is null where this client may not start a search. */
  context: {
    readonly popupOpen: boolean;
    readonly start: ((query: string) => unknown) | null;
  },
): boolean {
  if (event.key === "Escape") return context.popupOpen;
  if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  if (query.trim().length === 0 || context.start === null) return false;
  event.preventDefault();
  void context.start(query);
  return true;
}

/**
 * The thread an archived search result names. Its link carries only the
 * thread id (and the linking host), so the archived lists decide: the linking
 * host when it holds it, else the one other host that does.
 */
export function resolveArchivedResult(
  threadId: ThreadId,
  linkingEnvironmentId: EnvironmentId,
  archived: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }>,
): ScopedThreadRef | null {
  const holders = archived
    .filter((entry) => entry.threadIds.includes(threadId))
    .map((entry) => entry.environmentId);
  const environmentId = holders.includes(linkingEnvironmentId)
    ? linkingEnvironmentId
    : holders.length === 1
      ? holders[0]!
      : null;
  return environmentId === null ? null : { environmentId, threadId };
}
