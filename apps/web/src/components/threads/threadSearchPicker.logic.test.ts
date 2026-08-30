import { tokenizeThreadSearchQuery } from "@t3tools/client-runtime/state/thread-token-search";
import { describe, expect, it } from "vite-plus/test";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import {
  buildThreadSearchCandidates,
  buildThreadSearchGroups,
  THREAD_SEARCH_CONTENT_GROUP,
  THREAD_SEARCH_RECENT_GROUP,
  THREAD_SEARCH_TITLE_GROUP,
  threadSearchItemValue,
} from "./threadSearchPicker.logic.ts";

interface TestThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch?: string | null;
}

/** Stands in for `threadSearchMatchKey`: identity is environment plus thread,
    and these fixtures all live in one environment. */
const matchKeyFor = (threadId: string) => JSON.stringify(["env-1", threadId]);

const MESURA = "project-mesura";
const OTHER = "project-other";
const PROJECT_TITLE_BY_ID = new Map([
  [MESURA, "Mesura Code"],
  [OTHER, "Other Tools"],
]);

const RENAME: TestThread = { id: "t-rename", projectId: MESURA, title: "Rename the sidebar" };
const DEPLOY: TestThread = { id: "t-deploy", projectId: OTHER, title: "Deploy the relay" };
/** Its title says nothing about renaming; only its messages do. */
const SYNC: TestThread = { id: "t-sync", projectId: MESURA, title: "Weekly sync" };

function row(threadId: string): CommandPaletteActionItem {
  return {
    kind: "action",
    value: threadSearchItemValue(threadId),
    searchTerms: [],
    title: threadId,
    icon: null,
    run: async () => {},
  };
}

/** Threads arrive newest first, the order `buildThreadActionItems` returns. */
function candidates(
  threads: ReadonlyArray<TestThread>,
  withContentHit: ReadonlyArray<string> = [],
) {
  return buildThreadSearchCandidates({
    items: threads.map((thread) => row(thread.id)),
    threads: threads.map((thread) => ({ ...thread, matchKey: matchKeyFor(thread.id) })),
    projectTitleById: PROJECT_TITLE_BY_ID,
    contentMatchKeys: new Set(withContentHit.map(matchKeyFor)),
  });
}

function groupsFor(input: {
  threads: ReadonlyArray<TestThread>;
  query: string;
  withContentHit?: ReadonlyArray<string>;
  contentToken?: string | null;
  recentLimit?: number;
}) {
  return buildThreadSearchGroups({
    candidates: candidates(input.threads, input.withContentHit ?? []),
    tokens: tokenizeThreadSearchQuery(input.query),
    contentToken: input.contentToken ?? null,
    ...(input.recentLimit === undefined ? {} : { recentLimit: input.recentLimit }),
  });
}

const valuesIn = (group: { items: ReadonlyArray<{ value: string }> } | undefined) =>
  group?.items.map((item) => item.value) ?? [];

describe("pairing a row with the text it is searched by", () => {
  it("takes the fields from the thread, not from the rendered row", () => {
    const [candidate] = candidates([{ ...RENAME, branch: "feat/rename" }]);
    expect(candidate?.fields).toEqual({
      title: "Rename the sidebar",
      projectTitle: "Mesura Code",
      branch: "feat/rename",
    });
  });

  it("drops a row that has no thread behind it", () => {
    const built = buildThreadSearchCandidates({
      items: [row("t-missing"), { ...row("t-rename"), value: "action:new-thread" }],
      threads: [{ ...RENAME, matchKey: matchKeyFor(RENAME.id) }],
      projectTitleById: PROJECT_TITLE_BY_ID,
      contentMatchKeys: new Set(),
    });
    expect(built).toEqual([]);
  });

  it("marks the threads the server found the word inside", () => {
    expect(candidates([RENAME, SYNC], ["t-sync"]).map((c) => c.hasContentMatch)).toEqual([
      false,
      true,
    ]);
  });
});

// Criterion 5 — what an empty query shows.
describe("with an empty query", () => {
  it("lists recent threads", () => {
    const groups = groupsFor({ threads: [RENAME, DEPLOY], query: "" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe(THREAD_SEARCH_RECENT_GROUP);
    expect(valuesIn(groups[0])).toEqual([
      threadSearchItemValue("t-rename"),
      threadSearchItemValue("t-deploy"),
    ]);
  });

  it("stops at the recent limit rather than listing every thread ever", () => {
    const groups = groupsFor({ threads: [RENAME, DEPLOY, SYNC], query: "", recentLimit: 2 });
    expect(valuesIn(groups[0])).toHaveLength(2);
  });
});

// Criteria 6 and 8 — matching, grouping, and reaching every project.
describe("with a query", () => {
  it("finds a thread from its project name plus a word of its title, in either order", () => {
    for (const query of ["mesura rename", "rename mesura"]) {
      const groups = groupsFor({ threads: [RENAME, DEPLOY], query });
      expect(groups.map((group) => group.value)).toEqual([THREAD_SEARCH_TITLE_GROUP]);
      expect(valuesIn(groups[0])).toEqual([threadSearchItemValue("t-rename")]);
    }
  });

  it("reaches threads in every project, never only one scope", () => {
    const groups = groupsFor({ threads: [RENAME, DEPLOY], query: "the" });
    expect(valuesIn(groups[0])).toEqual([
      threadSearchItemValue("t-rename"),
      threadSearchItemValue("t-deploy"),
    ]);
  });

  it("returns nothing when a word matches nothing", () => {
    expect(groupsFor({ threads: [RENAME, DEPLOY], query: "mesura absent" })).toEqual([]);
  });

  it("puts a message-only hit under its own heading, after the field hits", () => {
    const groups = groupsFor({
      threads: [RENAME, SYNC],
      query: "mesura rename",
      withContentHit: ["t-sync"],
      contentToken: "rename",
    });
    expect(groups.map((group) => group.value)).toEqual([
      THREAD_SEARCH_TITLE_GROUP,
      THREAD_SEARCH_CONTENT_GROUP,
    ]);
    expect(valuesIn(groups[0])).toEqual([threadSearchItemValue("t-rename")]);
    expect(valuesIn(groups[1])).toEqual([threadSearchItemValue("t-sync")]);
  });

  it("ignores a message hit when no word was sent to the server", () => {
    expect(
      groupsFor({
        threads: [SYNC],
        query: "mesura rename",
        withContentHit: ["t-sync"],
        contentToken: null,
      }),
    ).toEqual([]);
  });

  it("breaks a tie by recency, which is the order the rows arrive in", () => {
    const newer = { id: "t-newer", projectId: MESURA, title: "Sidebar work" };
    const older = { id: "t-older", projectId: MESURA, title: "Sidebar work" };
    const groups = groupsFor({ threads: [newer, older], query: "sidebar" });
    expect(valuesIn(groups[0])).toEqual([
      threadSearchItemValue("t-newer"),
      threadSearchItemValue("t-older"),
    ]);
  });

  it("ranks a title hit above a hit that only the project name carries", () => {
    const byTitle = { id: "t-title", projectId: OTHER, title: "Mesura notes" };
    const byProject = { id: "t-project", projectId: MESURA, title: "Unrelated" };
    // byProject arrives first, so only ranking can put byTitle above it.
    const groups = groupsFor({ threads: [byProject, byTitle], query: "mesura" });
    expect(valuesIn(groups[0])).toEqual([
      threadSearchItemValue("t-title"),
      threadSearchItemValue("t-project"),
    ]);
  });
});

// Criterion 7 — the row numbers run down the visible list.
describe("row numbering", () => {
  it("numbers the first rows across both headings, not restarting at each", () => {
    const groups = groupsFor({
      threads: [RENAME, SYNC],
      query: "mesura rename",
      withContentHit: ["t-sync"],
      contentToken: "rename",
    });
    expect(groups[0]?.items[0]?.shortcutCommand).toBe("thread.jump.1");
    expect(groups[1]?.items[0]?.shortcutCommand).toBe("thread.jump.2");
  });

  it("numbers the recent list too", () => {
    const groups = groupsFor({ threads: [RENAME, DEPLOY], query: "" });
    expect(groups[0]?.items[0]?.shortcutCommand).toBe("thread.jump.1");
    expect(groups[0]?.items[1]?.shortcutCommand).toBe("thread.jump.2");
  });
});

// Guard. The review found this module keying content matches by thread id
// alone, where the rest of the codebase treats environment plus thread as one
// identity. A hit in one environment must never light up a thread in another.
describe("guards", () => {
  it("does not read a message hit from another environment as this thread's", () => {
    const sameIdElsewhere = JSON.stringify(["env-2", SYNC.id]);
    const built = buildThreadSearchCandidates({
      items: [row(SYNC.id)],
      threads: [{ ...SYNC, matchKey: matchKeyFor(SYNC.id) }],
      projectTitleById: PROJECT_TITLE_BY_ID,
      contentMatchKeys: new Set([sameIdElsewhere]),
    });
    expect(built[0]?.hasContentMatch).toBe(false);
  });
});
