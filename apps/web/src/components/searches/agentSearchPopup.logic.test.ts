/**
 * The agent search popup's pure state: starting a search opens it, choosing or deleting an earlier
 * search updates the active and unseen state, a search that settles while not shown stays unseen,
 * the sparkle shows for text or an unseen result, and history lists the hidden project only.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  THREAD_SEARCH_PROJECT_ID,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeFenceThreadShell } from "../../test/fenceThreadShell";
import {
  initialAgentSearchPopupState,
  isSearchRunning,
  reduceAgentSearchPopup,
  resolveArchivedResult,
  searchRunOf,
  searchSettled,
  selectSearchHistory,
  shouldShowAgentSearchSparkle,
} from "./agentSearchPopup.logic";

const environmentId = EnvironmentId.make("agent-search-logic-environment");
const first = scopeThreadRef(environmentId, ThreadId.make("search-first"));
const second = scopeThreadRef(environmentId, ThreadId.make("search-second"));

function openOn(search: typeof first) {
  return reduceAgentSearchPopup(initialAgentSearchPopupState, { type: "open", search });
}

describe("agent search popup logic: open and close", () => {
  it("agent search popup logic spec: starts closed with no active search and nothing unseen", () => {
    expect(initialAgentSearchPopupState).toMatchObject({
      open: false,
      activeSearch: null,
      unseenResult: null,
    });
  });

  it("agent search popup logic spec: opening on a search makes it the active search", () => {
    expect(openOn(first)).toMatchObject({ open: true, activeSearch: first });
  });

  it("agent search popup logic spec: closing keeps the active search for the next open", () => {
    const closed = reduceAgentSearchPopup(openOn(first), { type: "close" });
    expect(closed).toMatchObject({ open: false, activeSearch: first });
    const reopened = reduceAgentSearchPopup(closed, { type: "open" });
    expect(reopened).toMatchObject({ open: true, activeSearch: first });
  });
});

describe("agent search popup logic: the unseen result", () => {
  it("agent search popup logic spec: a search that settles while the popup is closed is unseen", () => {
    const closed = reduceAgentSearchPopup(openOn(first), { type: "close" });
    const settled = reduceAgentSearchPopup(closed, { type: "settled", search: first });
    expect(settled.unseenResult).toEqual(first);
  });

  it("agent search popup logic spec: a search that settles while the popup shows it is not unseen", () => {
    const settled = reduceAgentSearchPopup(openOn(first), { type: "settled", search: first });
    expect(settled.unseenResult).toBe(null);
  });

  it("agent search popup logic spec: a search that settles while the popup shows another search is unseen", () => {
    const onSecond = reduceAgentSearchPopup(openOn(first), { type: "select", search: second });
    const settled = reduceAgentSearchPopup(onSecond, { type: "settled", search: first });
    expect(settled.unseenResult).toEqual(first);
  });

  it("agent search popup logic spec: opening the unseen result clears it", () => {
    const closed = reduceAgentSearchPopup(openOn(first), { type: "close" });
    const settled = reduceAgentSearchPopup(closed, { type: "settled", search: first });
    const opened = reduceAgentSearchPopup(settled, { type: "open", search: first });
    expect(opened).toMatchObject({ open: true, activeSearch: first, unseenResult: null });
  });

  it("agent search popup logic spec: reopening the popup on its active unseen result clears it", () => {
    const closed = reduceAgentSearchPopup(openOn(first), { type: "close" });
    const settled = reduceAgentSearchPopup(closed, { type: "settled", search: first });
    const reopened = reduceAgentSearchPopup(settled, { type: "open" });
    expect(reopened).toMatchObject({ open: true, activeSearch: first, unseenResult: null });
  });
});

describe("agent search popup logic: history selection and deletion", () => {
  it("agent search popup logic spec: choosing an earlier search makes it active and keeps the popup open", () => {
    const chosen = reduceAgentSearchPopup(openOn(first), { type: "select", search: second });
    expect(chosen).toMatchObject({ open: true, activeSearch: second });
  });

  it("agent search popup logic spec: choosing the unseen search clears the unseen result", () => {
    const closed = reduceAgentSearchPopup(openOn(second), { type: "close" });
    const settled = reduceAgentSearchPopup(closed, { type: "settled", search: first });
    const reopened = reduceAgentSearchPopup(settled, { type: "open" });
    const chosen = reduceAgentSearchPopup(reopened, { type: "select", search: first });
    expect(chosen).toMatchObject({ activeSearch: first, unseenResult: null });
  });

  it("agent search popup logic spec: deleting the active search leaves no active search", () => {
    const deleted = reduceAgentSearchPopup(openOn(first), { type: "deleted", search: first });
    expect(deleted.activeSearch).toBe(null);
  });

  it("agent search popup logic spec: deleting another search keeps the active one", () => {
    const deleted = reduceAgentSearchPopup(openOn(first), { type: "deleted", search: second });
    expect(deleted.activeSearch).toEqual(first);
  });

  it("agent search popup logic spec: deleting the unseen search clears the unseen result", () => {
    const closed = reduceAgentSearchPopup(openOn(first), { type: "close" });
    const settled = reduceAgentSearchPopup(closed, { type: "settled", search: first });
    const deleted = reduceAgentSearchPopup(settled, { type: "deleted", search: first });
    expect(deleted.unseenResult).toBe(null);
  });

  it("agent search popup logic spec: the history lists only search-project threads, newest first", () => {
    const shell = (id: string, projectId: string, iso: string) =>
      makeFenceThreadShell({
        environmentId,
        id: ThreadId.make(id),
        projectId: ProjectId.make(projectId),
        createdAt: iso,
        overrides: { updatedAt: DateTime.makeUnsafe(iso) },
      });
    const history = selectSearchHistory([
      shell("older-search", THREAD_SEARCH_PROJECT_ID, "2026-10-20T10:00:00.000Z"),
      shell("ordinary-thread", "ordinary-project", "2026-10-24T10:00:00.000Z"),
      shell("newer-search", THREAD_SEARCH_PROJECT_ID, "2026-10-23T10:00:00.000Z"),
    ]);
    expect(history.map((thread) => thread.id)).toEqual(["newer-search", "older-search"]);
  });
});

describe("agent search popup logic: the sparkle in the field", () => {
  it("agent search popup logic spec: the sparkle shows while the field has text", () => {
    expect(shouldShowAgentSearchSparkle({ query: "rename", unseenResult: null })).toBe(true);
  });

  it("agent search popup logic spec: the sparkle shows on an empty field while a result is unseen", () => {
    expect(shouldShowAgentSearchSparkle({ query: "", unseenResult: first })).toBe(true);
  });

  it("agent search popup logic spec: the sparkle hides on a blank field with nothing unseen", () => {
    expect(shouldShowAgentSearchSparkle({ query: "   ", unseenResult: null })).toBe(false);
  });
});

// regression: reviewer-1 P1-5 — a run waiting for approval or input left the
// sidebar's "working" label, which read as the search ending.
describe("agent search popup logic: a search's run", () => {
  const RUN = RunId.make("search-run-1");
  const at = DateTime.makeUnsafe("2026-10-25T10:00:00.000Z");
  const searchShell = (overrides: Partial<OrchestrationV2ThreadShell>) =>
    makeFenceThreadShell({
      environmentId,
      id: ThreadId.make("search-run-thread"),
      projectId: ProjectId.make(THREAD_SEARCH_PROJECT_ID),
      overrides: { latestRunId: RUN, latestRunStartedAt: at, ...overrides },
    });
  const running = searchShell({ status: "running", activeRunId: RUN });
  const awaitingApproval = searchShell({
    status: "running",
    activeRunId: RUN,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("approval-1"),
      kind: "command",
      createdAt: at,
    },
  });
  const awaitingInput = searchShell({
    status: "running",
    activeRunId: RUN,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("input-1"),
      kind: "user_input",
      createdAt: at,
    },
  });
  const completed = searchShell({
    status: "completed",
    activeRunId: null,
    latestRunCompletedAt: at,
  });

  it("agent search popup logic spec: a run waiting for approval or input is still running", () => {
    expect(isSearchRunning(running)).toBe(true);
    expect(isSearchRunning(awaitingApproval)).toBe(true);
    expect(isSearchRunning(awaitingInput)).toBe(true);
    expect(isSearchRunning(completed)).toBe(false);
  });

  it("agent search popup logic spec: only the run reaching a terminal state settles the search", () => {
    expect(searchSettled(searchRunOf(running), searchRunOf(awaitingApproval))).toBe(false);
    expect(searchSettled(searchRunOf(awaitingApproval), searchRunOf(awaitingInput))).toBe(false);
    expect(searchSettled(searchRunOf(awaitingInput), searchRunOf(completed))).toBe(true);
    expect(searchSettled(searchRunOf(completed), searchRunOf(completed))).toBe(false);
  });

  it("agent search popup logic spec: a new run replacing a running one does not settle the search", () => {
    const next = searchShell({
      status: "running",
      latestRunId: RunId.make("search-run-2"),
      activeRunId: RunId.make("search-run-2"),
    });
    expect(searchSettled(searchRunOf(running), searchRunOf(next))).toBe(false);
  });
});

// regression: reviewer-1 P1-4 — an archived result's link pointed at a thread the
// route treats as missing, on the search host even when it lives elsewhere.
describe("agent search popup logic: an archived result", () => {
  const host = EnvironmentId.make("archived-result-host");
  const laptop = EnvironmentId.make("archived-result-laptop");
  const archived = (environmentId: EnvironmentId, ids: ReadonlyArray<string>) => ({
    environmentId,
    threadIds: ids.map((id) => ThreadId.make(id)),
  });

  it("agent search popup logic spec: an archived result resolves to the environment that holds it", () => {
    const ref = resolveArchivedResult(ThreadId.make("on-laptop"), host, [
      archived(host, ["on-host"]),
      archived(laptop, ["on-laptop"]),
    ]);
    expect(ref).toEqual({ environmentId: laptop, threadId: "on-laptop" });
  });

  it("agent search popup logic spec: an archived result on the linking host prefers that host", () => {
    const ref = resolveArchivedResult(ThreadId.make("on-both"), host, [
      archived(laptop, ["on-both"]),
      archived(host, ["on-both"]),
    ]);
    expect(ref).toEqual({ environmentId: host, threadId: "on-both" });
  });

  it("agent search popup logic spec: an archived result held by two other hosts is ambiguous", () => {
    const other = EnvironmentId.make("archived-result-other");
    expect(
      resolveArchivedResult(ThreadId.make("twice"), host, [
        archived(laptop, ["twice"]),
        archived(other, ["twice"]),
      ]),
    ).toBe(null);
    expect(resolveArchivedResult(ThreadId.make("nowhere"), host, [])).toBe(null);
  });
});
