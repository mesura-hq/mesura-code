import {
  type CommandPaletteActionItem,
  enumerateCommandPaletteItems,
  buildBrowseGroups,
} from "./CommandPalette.logic";
import { describe, expect, it, vi } from "vite-plus/test";

// Default mod+number bindings belong to Electron; web browsers own these chords.
vi.mock("../env", () => ({ isElectron: true }));

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { Project, Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  filterPinnedBrowseEntries,
  filterCommandPaletteGroups,
  findJumpTargetItem,
  findHighlightedCommandPaletteItem,
  reduceCommandPaletteUiState,
  createCommandPaletteSearchState,
  reduceCommandPaletteSearchState,
  type CommandPaletteUiState,
} from "./CommandPalette.logic";

const closedState: CommandPaletteUiState = { open: false, mode: "command", openIntent: null };

describe("linked pull request thread navigation", () => {
  it("keeps archived relations searchable and routes them through the PR environment", async () => {
    const environmentId = EnvironmentId.make("remote");
    const id = ThreadId.make("archived-thread");
    const runThread = vi.fn(async () => {});
    const query = "https://github.com/acme/web/pull/42";
    const linkedThreads = {
      environmentId,
      threads: [
        {
          id,
          projectId: ProjectId.make("project"),
          title: "Completed work",
          archivedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    const state = reduceCommandPaletteUiState(
      { open: false, mode: "command", openIntent: null },
      {
        _tag: "OpenSearch",
        query,
        linkedThreads,
      },
    );
    expect(state.openIntent).toEqual({ kind: "search", query, linkedThreads });
    const items = buildLinkedThreadActionItems({ ...linkedThreads, query, icon: null, runThread });
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query,
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });
    expect(groups.flatMap((group) => group.items)).toEqual(items);
    expect(items[0]?.description).toBe("Archived thread");
    await items[0]?.run();
    expect(runThread).toHaveBeenCalledWith({ environmentId, id });
  });
});

describe("reduceCommandPaletteUiState", () => {
  it("opens PR search from another overlay and replaces an earlier search", () => {
    const first = reduceCommandPaletteUiState(
      { open: true, mode: "files", openIntent: null },
      {
        _tag: "OpenSearch",
        query: "https://github.com/acme/web/pull/7",
      },
    );
    expect(first).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "search", query: "https://github.com/acme/web/pull/7" },
    });
    const second = reduceCommandPaletteUiState(first, {
      _tag: "OpenSearch",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(second.openIntent).toEqual({
      kind: "search",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(
      reduceCommandPaletteUiState(second, { _tag: "SetOpen", open: false }).openIntent,
    ).toBeNull();
  });

  it("routes open intents to command mode", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenAddProject" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project" },
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewThreadIn" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-thread-in" },
    });
  });

  it("preserves the mode on close and resets it on open", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      mode: "files",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
  });
});

describe("findJumpTargetItem", () => {
  const press = (key: string) => ({
    key,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  });
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "a",
      searchTerms: ["a"],
      title: "a",
      icon: null,
      shortcutCommand: "thread.jump.1",
      run: async () => {},
    },
    {
      kind: "action",
      value: "b",
      searchTerms: ["b"],
      title: "b",
      icon: null,
      shortcutCommand: "thread.jump.2",
      run: async () => {},
    },
  ];

  it("returns the row the pressed jump chord names", () => {
    expect(
      findJumpTargetItem({
        event: press("2"),
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        items,
        platform: "Linux",
      })?.value,
    ).toBe("b");
  });

  it("returns the tenth row for the tenth jump chord", () => {
    const tenItems = THREAD_JUMP_KEYBINDING_COMMANDS.map((shortcutCommand, index) => ({
      ...items[0]!,
      value: `row-${index + 1}`,
      shortcutCommand,
    }));
    expect(
      findJumpTargetItem({
        event: press("0"),
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        items: tenItems,
        platform: "Linux",
      })?.value,
    ).toBe("row-10");
  });

  it("returns null for a chord that is not a jump", () => {
    expect(
      findJumpTargetItem({
        event: press("k"),
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        items,
        platform: "Linux",
      }),
    ).toBe(null);
  });

  it("returns null when the jump chord names a row that is not on screen", () => {
    expect(
      findJumpTargetItem({
        event: press("7"),
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        items,
        platform: "Linux",
      }),
    ).toBe(null);
  });
});

describe("enumerateCommandPaletteItems", () => {
  // Mesura: ten, with Ctrl+0 for the tenth.
  it("assigns positional jump shortcuts to the first ten displayed items", () => {
    const items = Array.from({ length: 11 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      "thread.jump.10",
      undefined,
    ]);
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("buildThreadActionItems", () => {
  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("orders title matches by recent activity before older prefix matches", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("old-prefix"),
        title: "Convex InvalidCursor in Convex threads query",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-title"),
        title: "Disable Convex schema validation",
        createdAt: "2025-12-01T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-content"),
        title: "Fix schema validation",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      }),
    ];
    const items = buildThreadActionItems({
      threads,
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "created_at",
      icon: null,
      getContentMatch: (thread) =>
        thread.id === ThreadId.make("recent-content")
          ? { source: "user", snippet: "Please check Convex", query: "convex" }
          : undefined,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "convex",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:recent-title",
      "thread:old-prefix",
      "thread:recent-content",
    ]);
  });

  it("ranks an order-independent setting title match above a split context match", () => {
    const settingsSearchItems = [
      {
        kind: "action" as const,
        value: "setting:context-match",
        searchTerms: ["Pairing settings", "remote backend"],
        title: "Context match",
        icon: null,
        run: async () => undefined,
      },
      {
        kind: "action" as const,
        value: "setting:remote-pairing",
        searchTerms: ["Remote pairing", "connections"],
        title: "Remote pairing",
        icon: null,
        run: async () => undefined,
      },
    ];

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "pairing remote",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems,
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("settings-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "setting:remote-pairing",
      "setting:context-match",
    ]);
  });

  it("normalizes case independently of the host locale", () => {
    const toLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (this: string) {
        return toLocaleLowerCase.call(this, "tr");
      });
    try {
      const groups = filterCommandPaletteGroups({
        activeGroups: [],
        query: "GIT",
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
        settingsSearchItems: [
          {
            kind: "action",
            value: "setting:version-control",
            title: "Version control",
            searchTerms: ["git"],
            icon: null,
            run: async () => undefined,
          },
        ],
      });
      expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "setting:version-control",
      ]);
    } finally {
      localeLowerCase.mockRestore();
    }
  });

  it("keeps message excerpts searchable without replacing thread metadata", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search" })],
      projectTitleById: new Map([[PROJECT_ID, "Mesura Code"]]),
      sortOrder: "updated_at",
      icon: null,
      getContentMatch: () => ({
        source: "assistant",
        snippet: "The relay reconnect is now bounded.",
        query: "reconnect",
      }),
      runThread: async (_thread) => undefined,
    });

    expect(item?.searchTerms).toContain("The relay reconnect is now bounded.");
    expect(item?.threadContentMatch).toEqual({
      source: "assistant",
      snippet: "The relay reconnect is now bounded.",
      query: "reconnect",
    });
    expect(item?.description).toBe("Mesura Code · #feat/search");
  });

  it("surfaces threads when the query is their ID, without outranking title matches", () => {
    const idThread = makeThread({
      id: ThreadId.make("thread-alpha-1234"),
      title: "Unrelated work",
      updatedAt: "2026-03-05T00:00:00.000Z",
    });
    const titleThread = makeThread({
      id: ThreadId.make("thread-other-9999"),
      title: "Fix thread-alpha-1234 flakes",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const items = buildThreadActionItems({
      threads: [idThread, titleThread],
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "  THREAD-ALPHA-1234  ",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups.flatMap((group) => group.items)).toEqual([
      expect.objectContaining({ value: `thread:${titleThread.id}` }),
      expect.objectContaining({ value: `thread:${idThread.id}` }),
    ]);
  });

  it("prefers renderDescription when provided", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search", worktreePath: "/tmp/wt" })],
      projectTitleById: new Map([[PROJECT_ID, "Mesura Code"]]),
      sortOrder: "updated_at",
      icon: null,
      renderDescription: (thread, { projectTitle }) =>
        `${projectTitle}:${thread.branch}:${thread.worktreePath ? "wt" : "local"}`,
      runThread: async (_thread) => undefined,
    });

    expect(item?.description).toBe("Mesura Code:feat/search:wt");
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});

describe("buildBrowseGroups", () => {
  it("waits for asynchronous browse navigation actions", async () => {
    let finishNavigation: (() => void) | undefined;
    const browseTo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve;
        }),
    );
    const groups = buildBrowseGroups({
      browseEntries: [{ name: "Downloads", fullPath: "/Users/test/Downloads" }],
      browseQuery: "~/",
      canBrowseUp: false,
      upIcon: null,
      directoryIcon: null,
      browseUp: vi.fn(),
      browseTo,
    });
    const item = groups[0]?.items[0];
    if (!item || item.kind !== "action") {
      throw new Error("Expected a browse action");
    }

    let actionSettled = false;
    const action = item.run().then(() => {
      actionSettled = true;
    });
    await Promise.resolve();

    expect(browseTo).toHaveBeenCalledWith("Downloads");
    expect(actionSettled).toBe(false);

    finishNavigation?.();
    await action;
    expect(actionSettled).toBe(true);
  });
});

describe("filterPinnedBrowseEntries", () => {
  it("matches an existing pinned destination without Windows casing", () => {
    const windowsEntries = [
      { name: "Repo", fullPath: "C:\\projects\\Repo" },
      { name: "work", fullPath: "C:\\projects\\work" },
    ];
    expect(
      filterPinnedBrowseEntries({
        browseEntries: windowsEntries,
        filterQuery: "repo",
        pinnedDirectoryName: "repo",
        caseSensitive: false,
      }),
    ).toEqual({
      visibleEntries: windowsEntries,
      exactEntry: windowsEntries[0],
    });
  });
});

it.each([
  "#10839",
  "10839",
  "pingdotgg/t3code#10839",
  "https://github.com/pingdotgg/t3code/pull/10839",
])("finds linked threads from PR query %s", (query) => {
  const items = buildThreadActionItems({
    threads: [
      makeThread({
        title: "Implementation",
        pullRequests: [
          {
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 10839,
            url: "https://github.com/pingdotgg/t3code/pull/10839",
            source: "manual",
            linkedAt: "2026-09-08T00:00:00Z",
            snapshot: null,
            stack: null,
          },
        ],
      }),
      makeThread({ id: ThreadId.make("unrelated"), title: "Other work" }),
    ],
    projectTitleById: new Map(),
    sortOrder: "updated_at",
    icon: null,
    runThread: async () => undefined,
  });
  const groups = filterCommandPaletteGroups({
    activeGroups: [],
    query,
    isInSubmenu: false,
    projectSearchItems: [],
    threadSearchItems: items,
  });
  expect(groups.flatMap((group) => group.items.map((item) => item.title))).toEqual([
    "Implementation",
  ]);
});

describe("command palette search return", () => {
  const picker = { addonIcon: null, groups: [] };

  it("restores each parent query when backing out of nested pickers", () => {
    let state = createCommandPaletteSearchState(">new thread");
    state = reduceCommandPaletteSearchState(state, { type: "push", view: picker });
    expect(state.query).toBe("");
    state = reduceCommandPaletteSearchState(state, { type: "query", query: "remote project" });
    state = reduceCommandPaletteSearchState(state, {
      type: "push",
      view: { ...picker, initialQuery: "~/" },
    });
    expect(state.query).toBe("~/");

    state = reduceCommandPaletteSearchState(state, { type: "query", query: "" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("remote project");
    expect(state.views).toHaveLength(1);
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe(">new thread");
    expect(state.views).toHaveLength(0);
  });

  it("cannot return to an old picker after a new search replaces it", () => {
    let state = reduceCommandPaletteSearchState(createCommandPaletteSearchState("old"), {
      type: "push",
      view: picker,
    });
    state = reduceCommandPaletteSearchState(state, { type: "reset", query: "fresh" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("fresh");
    expect(state.views).toHaveLength(0);
  });
});

describe("returning from file and content search", () => {
  const root: CommandPaletteUiState = { open: true, mode: "command", openIntent: null };
  const query = "https://github.com/acme/web/pull/7";
  const context = {
    query,
    linkedThreadSearch: {
      kind: "search" as const,
      query,
      linkedThreads: {
        environmentId: EnvironmentId.make("remote"),
        threads: [
          {
            id: ThreadId.make("linked-thread"),
            projectId: ProjectId.make("project"),
            title: "Completed work",
            archivedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    },
  };

  it.each(["files", "content"] as const)(
    "Escape from %s restores the query and linked-thread results",
    (mode) => {
      const child = reduceCommandPaletteUiState(root, { _tag: "OpenChildSearch", mode, context });
      expect(child.mode).toBe(mode);
      const returned = reduceCommandPaletteUiState(child, { _tag: "BackToCommand" });
      expect(returned).toEqual({ ...root, restoredSearch: context });
      expect(reduceCommandPaletteUiState(returned, { _tag: "BackToCommand" })).toEqual(returned);
    },
  );

  it("closing a child search discards its return context before reopening", () => {
    const child: CommandPaletteUiState = { ...root, mode: "files", parentSearch: context };
    const closed = reduceCommandPaletteUiState(child, { _tag: "SetOpen", open: false });
    expect(closed).toEqual({ open: false, mode: "files", openIntent: null });
    expect(reduceCommandPaletteUiState(closed, { _tag: "BackToCommand" })).toEqual(closed);
    expect(reduceCommandPaletteUiState(closed, { _tag: "SetOpen", open: true })).toEqual(root);
  });
});
