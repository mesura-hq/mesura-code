/**
 * Search unification phase 1, criteria 1 and 2 at the logic level: the sidebar's
 * search pool reaches every project while the query has text, and the results
 * keep the order the sidebar gave them (field matches first, then message
 * matches), with no word score.
 *
 * The pipeline under test is the one `Sidebar.tsx` runs: the scope rule picks
 * the project keys, `filterSidebarV2VisibleThreads` narrows the shells to them,
 * and `searchSidebarThreads` filters the result in its input order.
 */
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterSidebarV2VisibleThreads, searchSidebarThreads } from "../Sidebar.logic";
import { resolveSidebarSearchProjectKeys } from "./sidebarSearchScope";

const environmentId = EnvironmentId.make("environment-search-scope");
const PROJECT_TITLE_BY_ID = new Map([
  ["project-alpha", "Alpha"],
  ["project-beta", "Beta"],
]);
const ALPHA_ONLY: ReadonlySet<string> = new Set([`${environmentId}:project-alpha`]);
const NO_DELEGATED: ReadonlySet<string> = new Set();

function shell(id: string, title: string, projectId: string, branch: string | null = null) {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    projectId,
    branch,
    archivedAt: null as string | null,
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: null,
      relationshipToParent: null,
    },
  };
}

/** The sidebar's search pipeline, in the order `Sidebar.tsx` runs it. */
function searchPool(
  threads: ReadonlyArray<ReturnType<typeof shell>>,
  query: string,
  scopedProjectKeys: ReadonlySet<string> | null,
  contentMatchIds: ReadonlyArray<string> = [],
) {
  const visible = filterSidebarV2VisibleThreads(
    threads,
    resolveSidebarSearchProjectKeys(query, scopedProjectKeys),
    NO_DELEGATED,
  );
  return searchSidebarThreads(
    visible,
    query,
    PROJECT_TITLE_BY_ID,
    new Set(
      contentMatchIds.map((id) =>
        threadSearchMatchKey({ environmentId, threadId: ThreadId.make(id) }),
      ),
    ),
  ).map((thread) => thread.id);
}

describe("resolveSidebarSearchProjectKeys", () => {
  it("search scope spec: a non-empty query searches every project despite the filter", () => {
    expect(resolveSidebarSearchProjectKeys("rename", ALPHA_ONLY)).toBeNull();
  });

  it("search scope spec: a query of only spaces keeps the project filter", () => {
    expect(resolveSidebarSearchProjectKeys("   ", ALPHA_ONLY)).toBe(ALPHA_ONLY);
  });

  it("search scope spec: an empty query keeps the project filter", () => {
    expect(resolveSidebarSearchProjectKeys("", ALPHA_ONLY)).toBe(ALPHA_ONLY);
  });

  it("search scope spec: with no filter every project stays in scope for any query", () => {
    expect(resolveSidebarSearchProjectKeys("", null)).toBeNull();
    expect(resolveSidebarSearchProjectKeys("rename", null)).toBeNull();
  });
});

describe("sidebar search pool with a project filter", () => {
  const threads = [
    shell("beta-rename", "Rename the sidebar", "project-beta"),
    shell("alpha-rename", "Rename settings", "project-alpha"),
    shell("alpha-other", "Unrelated work", "project-alpha"),
  ];

  it("search scope spec: a query under an Alpha filter finds the matching Beta thread too", () => {
    expect(searchPool(threads, "rename", ALPHA_ONLY)).toEqual(["beta-rename", "alpha-rename"]);
  });

  it("search scope spec: clearing the query hands the pool back to the Alpha filter", () => {
    const visible = filterSidebarV2VisibleThreads(
      threads,
      resolveSidebarSearchProjectKeys("", ALPHA_ONLY),
      NO_DELEGATED,
    );
    expect(visible.map((thread) => thread.id)).toEqual(["alpha-rename", "alpha-other"]);
  });

  it("search scope spec: archived threads stay out of the all-project search", () => {
    const archived = {
      ...shell("beta-archived", "Rename archived", "project-beta"),
      archivedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(searchPool([...threads, archived], "rename", ALPHA_ONLY)).toEqual([
      "beta-rename",
      "alpha-rename",
    ]);
  });
});

describe("sidebar search order across projects", () => {
  // The sidebar hands the pool newest first. The 58-day-old Alpha thread holds
  // both query words in its title; the newer Beta thread holds one in its title
  // and the other in its branch. The former word score ranked a title hit above
  // a branch hit and lifted the older thread; the sidebar order must win.
  const sidebarOrder = [
    shell("beta-new", "Sidebar polish", "project-beta", "rename-flow"),
    shell("alpha-58-days", "Sidebar rename", "project-alpha"),
    shell("alpha-message-hit", "Provider settings", "project-alpha"),
    shell("beta-message-hit", "Composer focus", "project-beta"),
  ];

  it("search scope spec: field matches from both projects keep the sidebar's recency order, then message matches", () => {
    expect(
      searchPool(sidebarOrder, "sidebar rename", ALPHA_ONLY, [
        "beta-message-hit",
        "alpha-message-hit",
      ]),
    ).toEqual(["beta-new", "alpha-58-days", "alpha-message-hit", "beta-message-hit"]);
  });
});
