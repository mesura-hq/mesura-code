// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router rendering the real ChatView, whose
 * right panel is opened on the Diff surface through `useRightPanelStore`, the
 * same store the Diff tab and `diff.toggle` write. ChatView, DiffPanel, the
 * Tree diff view and the diff store remain real.
 *
 * Tree diff phase 2, acceptance criteria 1–5, 7 and 8. Criterion 6 (colours)
 * is a visual criterion: the colours are CSS custom properties on the tree host
 * and a letter swapped in CSS, and AGENTS.md rules out asserting markup; the
 * status mapping behind them is pinned in `treeDiff.logic.test.ts`, and the
 * colours themselves are verified in the dev server.
 *
 * Boundaries the fixture replaces, and nothing else:
 * - The server, at the four atom-family factories in
 *   `@t3tools/client-runtime/state/runtime`. Every query and subscription the
 *   app builds becomes a fixture atom that records each read (a request) by RPC
 *   tag or label, and answers `review.subscribeWorkingTreeChanges`,
 *   `review.getWorkingTreeChanges` and `subscribeVcsStatus` from the fixture.
 *   Pushing a new live value re-renders its readers, as a stream emission does.
 * - Environment, thread and project reads, RPC commands and unrelated chrome,
 *   as `AppRoot.pendingUserInput.test.tsx` does, and the diff highlighting
 *   worker pool, which happy-dom cannot start.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type GitWorkingTreeChange,
  type GitWorkingTreeChangesResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

type FixtureResult =
  | { readonly kind: "initial" }
  | { readonly kind: "success"; readonly value: unknown }
  | { readonly kind: "failure"; readonly message: string };

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  noopCommand: async () => ({ _tag: "Success", value: undefined }),
  empty: [],
  threadListeners: new Set<() => void>(),
  /** Every fixture atom, so the query hook can tell them from real ones. */
  atoms: new WeakSet<object>(),
  /** One entry per read of a query or subscription: the request it stands for. */
  requests: [] as Array<{ key: string; input: unknown }>,
  /** Re-reads every mounted fixture atom; a live push. */
  listeners: new Set<() => void>(),
  liveChanges: { kind: "initial" } as FixtureResult,
  oneShotChanges: { kind: "initial" } as FixtureResult,
  vcsStatus: null as unknown,
  diffPreview: { kind: "initial" } as FixtureResult,
  runQuery: null as (() => Promise<unknown>) | null,
  environments: [
    {
      environmentId: "tree-diff-fence-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      serverConfig: {
        environment: { capabilities: {} },
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-10-06T12:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
      },
    },
  ],
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const Cause = await import("effect/Cause");
  const { WS_METHODS: methods } = await import("@t3tools/contracts");

  const resolve = (key: string) => {
    const result =
      key === methods.reviewSubscribeWorkingTreeChanges
        ? fixture.liveChanges
        : key === methods.reviewGetWorkingTreeChanges
          ? fixture.oneShotChanges
          : key === methods.reviewGetDiffPreview
            ? fixture.diffPreview
            : key === "environment-data:vcs:status" && fixture.vcsStatus !== null
              ? ({ kind: "success", value: fixture.vcsStatus } as const)
              : ({ kind: "initial" } as const);
    switch (result.kind) {
      case "success":
        return AsyncResult.success(result.value);
      case "failure":
        return AsyncResult.failure(Cause.fail(new Error(result.message)));
      default:
        return AsyncResult.initial(true);
    }
  };
  const familyFor = (key: string) => {
    const cache = new Map<string, object>();
    return (target: { environmentId: string; input: unknown }) => {
      const cacheKey = JSON.stringify(target);
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const atom = Atom.make((get) => {
        fixture.requests.push({ key, input: target.input });
        const listener = () => get.setSelf(resolve(key));
        fixture.listeners.add(listener);
        get.addFinalizer(() => fixture.listeners.delete(listener));
        return resolve(key);
      });
      fixture.atoms.add(atom);
      cache.set(cacheKey, atom);
      return atom;
    };
  };
  return {
    ...actual,
    createEnvironmentRpcQueryAtomFamily: (_runtime: unknown, options: { tag: string }) =>
      familyFor(options.tag),
    createEnvironmentRpcSubscriptionAtomFamily: (_runtime: unknown, options: { tag: string }) =>
      familyFor(options.tag),
    createEnvironmentQueryAtomFamily: (_runtime: unknown, options: { label: string }) =>
      familyFor(options.label),
    createEnvironmentSubscriptionAtomFamily: (_runtime: unknown, options: { label: string }) =>
      familyFor(options.label),
  };
});
vi.mock("./state/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/query")>();
  return {
    ...actual,
    // Fixture atoms read for real; anything else reads as an idle, empty query.
    useEnvironmentQuery: (atom: Parameters<typeof actual.useEnvironmentQuery>[0]) =>
      actual.useEnvironmentQuery(atom !== null && fixture.atoms.has(atom) ? atom : null),
  };
});
vi.mock("./state/entities", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const useFixtureThread = () =>
    useSyncExternalStore(
      (listener) => {
        fixture.threadListeners.add(listener);
        return () => {
          fixture.threadListeners.delete(listener);
        };
      },
      () => fixture.thread,
    );
  return {
    ...(await importOriginal<typeof import("./state/entities")>()),
    useThread: useFixtureThread,
    readThread: () => fixture.thread,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => null,
  };
});
vi.mock("./state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments, isReady: true }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("./state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: () => fixture.noopCommand,
}));
vi.mock("./state/use-atom-query-runner", () => ({
  // One-shot reads, such as Tree diff's refresh, answer from `fixture.runQuery` when set.
  useAtomQueryRunner: () => () => (fixture.runQuery ?? fixture.noopCommand)(),
}));
vi.mock("./hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  return {
    ...(await importOriginal<typeof import("./hooks/useSettings")>()),
    useEnvironmentSettings: () => settings,
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
  };
});
vi.mock("./hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => fixture.noopCommand }));
vi.mock("./hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: fixture.noopCommand,
    pinThread: fixture.noopCommand,
    confirmAndUnpinThread: fixture.noopCommand,
  }),
}));
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
// happy-dom has no module workers. Files diff's code view renders without its
// highlighting pool, which is unrelated to the file tree under test.
vi.mock("./components/DiffWorkerPoolProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components/DiffWorkerPoolProvider")>()),
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: Array<{ id: string }>;
    renderItem: (input: { item: { id: string } }) => ReactNode;
  }) => (
    <div>
      {data.map((item) => (
        <div key={item.id}>{renderItem({ item })}</div>
      ))}
    </div>
  ),
}));

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AppRoot } from "./AppRoot";
import ChatView from "./components/ChatView";
import { SidebarProvider } from "./components/ui/sidebar";
import { useDiffPanelStore, type DiffGitScope } from "./diffPanelStore";
import { gitChangeRows } from "./components/treeDiff/treeDiff.logic";
import { openGitChangeFile } from "./components/treeDiff/useWorkingTreeChanges";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const environmentId = EnvironmentId.make("tree-diff-fence-environment");
const threadId = ThreadId.make("tree-diff-fence-thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const worktreePath = "/tmp/tree-diff-fence/repo";
const now = "2026-10-06T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;

function change(
  path: string,
  index: GitWorkingTreeChange["index"],
  worktree: GitWorkingTreeChange["worktree"],
  staged: [number, number],
  unstaged: [number, number],
): GitWorkingTreeChange {
  return {
    path,
    index,
    worktree,
    staged: { insertions: staged[0], deletions: staged[1] },
    unstaged: { insertions: unstaged[0], deletions: unstaged[1] },
    binary: false,
  };
}

function changes(files: ReadonlyArray<GitWorkingTreeChange>): GitWorkingTreeChangesResult {
  return {
    isRepo: true,
    repositoryRoot: worktreePath,
    refName: "feature/tree-diff",
    files,
    truncated: false,
  };
}

/** Staged and unstaged non-empty, untracked empty: its summary row is left out. */
const DIRTY = changes([
  change("src/staged.ts", "M", ".", [4, 1], [0, 0]),
  change("src/edited.ts", ".", "M", [0, 0], [7, 2]),
]);

function dirtyVcsStatus() {
  return {
    isRepo: true,
    hasWorkingTreeChanges: true,
    refName: "feature/tree-diff",
    workingTree: { files: [], insertions: 11, deletions: 3 },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  fixture.requests.length = 0;
  fixture.runQuery = null;
  fixture.diffPreview = { kind: "initial" };
  fixture.liveChanges = { kind: "success", value: DIRTY };
  fixture.oneShotChanges = { kind: "success", value: DIRTY };
  fixture.vcsStatus = dirtyVcsStatus();
  fixture.thread = {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("tree-diff-fence-project"),
    title: "Tree diff fence",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    checkpoints: [],
    pullRequests: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: "feature/tree-diff",
    worktreePath,
    activities: [],
  };
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

/** Mounts the app with the thread's right panel open on the Diff surface. */
async function mountDiffSurface(storedScope?: DiffGitScope | "tree") {
  if (storedScope !== undefined) {
    useDiffPanelStore.getState().selectGitScope(threadRef, storedScope as DiffGitScope);
  }
  useRightPanelStore.getState().open(threadRef, "diff");
  // DiffPanel reads the thread from the route's params, as on `/$environmentId/$threadId`.
  const route = createRootRoute();
  const threadRoute = createRoute({
    getParentRoute: () => route,
    path: "/$environmentId/$threadId",
    component: () => (
      <SidebarProvider>
        <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: route.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: [`/${environmentId}/${threadId}`] }),
  });
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
  // DiffPanel is lazy: wait for its chunk to load and render its header.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (document.body.querySelector('[aria-label^="Diff scope: "]')) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  await settle();
}

async function settle() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function modeTrigger(): HTMLElement {
  const trigger = document.body.querySelector<HTMLElement>('[aria-label^="Diff scope: "]');
  expect(
    trigger,
    `Expected the Diff mode menu; rendered: ${document.body.textContent}`,
  ).not.toBeNull();
  return trigger!;
}

const selectedMode = () => modeTrigger().getAttribute("aria-label")!.replace("Diff scope: ", "");

async function openModeMenu(): Promise<string[]> {
  const trigger = modeTrigger();
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await settle();
  const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(
    items.length,
    `Expected an open mode menu; rendered: ${document.body.textContent}`,
  ).toBeGreaterThan(0);
  return items.map((item) => item.textContent?.trim() ?? "");
}

const viewText = () => document.body.textContent ?? "";

/** The tree's rows, through Pierre's own row attributes, including its shadow root. */
function treeRows(): HTMLElement[] {
  const roots: Array<ParentNode> = [document];
  for (const element of document.querySelectorAll("*")) {
    if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  return roots.flatMap((node) => [...node.querySelectorAll<HTMLElement>("[data-item-path]")]);
}

const treeRowPaths = () => treeRows().map((row) => row.getAttribute("data-item-path")!);

/** What one file row shows: its git status, its letter and its line counts. */
function treeRow(path: string) {
  const row = treeRows().find((entry) => entry.getAttribute("data-item-path") === path);
  expect(row, `Expected a tree row for ${path}; rows: ${treeRowPaths().join(", ")}`).toBeDefined();
  const section = (name: string) =>
    row!.querySelector(`[data-item-section='${name}']`)?.textContent?.trim() ?? "";
  return {
    status: row!.getAttribute("data-item-git-status"),
    letter: section("git"),
    counts: section("decoration"),
  };
}

const requestsFor = (key: string) => fixture.requests.filter((request) => request.key === key);

async function pushLive(result: GitWorkingTreeChangesResult) {
  await act(async () => {
    fixture.liveChanges = { kind: "success", value: result };
    // A copy: a listener re-reads its atom, which can register a listener again.
    for (const listener of Array.from(fixture.listeners)) listener();
  });
  await settle();
}

it("Tree diff fence: the mode menu lists Tree diff, Files diff, Branch changes, Latest turn, Turn in order", async () => {
  await mountDiffSurface("branch");
  const labels = await openModeMenu();
  expect(labels.map((label) => label.replace(/\s+/g, " "))).toEqual([
    "Tree diff",
    "Files diff",
    "Branch changes",
    "Latest turn",
    "Turn",
  ]);
  for (const label of labels) {
    expect(label).not.toMatch(/Working tree|Uncommitted/);
  }
});

it("Tree diff fence: a dirty thread with no stored mode opens on Tree diff", async () => {
  await mountDiffSurface();
  expect(selectedMode()).toBe("Tree diff");
});

it("Tree diff fence: a mode stored for a dirty thread still wins over the Tree diff default", async () => {
  await mountDiffSurface("branch");
  expect(selectedMode()).toBe("Branch changes");
});

it("Tree diff fence: Tree diff shows the branch, non-empty summary rows and lettered rows with counts", async () => {
  await mountDiffSurface("tree");
  expect(selectedMode()).toBe("Tree diff");
  const text = viewText();
  expect(text).toContain("feature/tree-diff");
  expect(text).toContain("staged");
  expect(text).toContain("unstaged");
  // Untracked has no files, so its row is left out.
  expect(text).not.toContain("untracked");
  expect(text).toContain("+4");
  expect(text).toContain("+7");
  expect(treeRow("src/staged.ts")).toEqual({ status: "modified", letter: "M", counts: "+4 −1" });
  expect(treeRow("src/edited.ts")).toEqual({ status: "modified", letter: "M", counts: "+7 −2" });
});

it("Tree diff fence: a file changed on disk appears in Tree diff from the live stream alone", async () => {
  await mountDiffSurface("tree");
  expect(requestsFor(WS_METHODS.reviewSubscribeWorkingTreeChanges).length).toBeGreaterThan(0);
  const oneShotReadsBefore = requestsFor(WS_METHODS.reviewGetWorkingTreeChanges).length;
  await pushLive(changes([...DIRTY.files, change("src/new-on-disk.ts", "?", "?", [0, 0], [3, 0])]));
  expect(treeRow("src/new-on-disk.ts")).toMatchObject({ status: "untracked", counts: "+3" });
  expect(viewText()).toContain("untracked");
  // Nothing re-asked the server: the stream carried the change.
  expect(requestsFor(WS_METHODS.reviewGetWorkingTreeChanges).length).toBe(oneShotReadsBefore);
});

it("Tree diff fence: Tree diff sends no diff preview or ref-listing request", async () => {
  await mountDiffSurface("tree");
  expect(requestsFor(WS_METHODS.reviewSubscribeWorkingTreeChanges).length).toBeGreaterThan(0);
  expect(requestsFor(WS_METHODS.reviewGetDiffPreview)).toEqual([]);
  expect(requestsFor(WS_METHODS.vcsListRefs)).toEqual([]);
});

it("Tree diff fence: a refused folder reads as one plain sentence, not the server error", async () => {
  const serverText = `Workspace ${worktreePath} is outside the configured workspace root /srv/other.`;
  fixture.liveChanges = { kind: "failure", message: serverText };
  fixture.oneShotChanges = { kind: "failure", message: serverText };
  await mountDiffSurface("tree");
  expect(viewText()).toContain("This server can't read this project's folder.");
  expect(viewText()).not.toContain("configured workspace root");
});

it("Tree diff fence: a clean working tree from the live stream reads Working tree clean", async () => {
  fixture.liveChanges = { kind: "success", value: changes([]) };
  fixture.oneShotChanges = { kind: "initial" };
  await mountDiffSurface("tree");
  expect(viewText()).toContain("Working tree clean");
});

it("Tree diff fence: a failed refresh says why beside the result it kept, until a newer one arrives", async () => {
  fixture.runQuery = async () =>
    AsyncResult.failure(Cause.fail(new Error("git status failed: index.lock exists")));
  await mountDiffSurface("tree");
  const refreshButton = document.body.querySelector<HTMLElement>(
    '[aria-label="Refresh tree diff"]',
  );
  expect(refreshButton, `Expected the refresh button; rendered: ${viewText()}`).not.toBeNull();
  await act(async () => refreshButton!.click());
  await settle();

  expect(viewText()).toContain("Refresh failed: git status failed: index.lock exists");
  expect(treeRow("src/edited.ts")).toMatchObject({ counts: "+7 −2" });

  await pushLive(changes([change("src/edited.ts", ".", "M", [0, 0], [8, 2])]));
  expect(viewText()).not.toContain("Refresh failed");
  expect(treeRow("src/edited.ts")).toMatchObject({ counts: "+8 −2" });
});

async function clickRefresh() {
  const refreshButton = document.body.querySelector<HTMLElement>(
    '[aria-label="Refresh tree diff"]',
  );
  expect(refreshButton, `Expected the refresh button; rendered: ${viewText()}`).not.toBeNull();
  await act(async () => refreshButton!.click());
}

it("Tree diff fence: a refresh's answer shows until the stream sends a newer one", async () => {
  fixture.runQuery = async () =>
    AsyncResult.success(changes([change("src/edited.ts", ".", "M", [0, 0], [9, 2])]));
  await mountDiffSurface("tree");
  await clickRefresh();
  await settle();
  expect(treeRow("src/edited.ts")).toMatchObject({ counts: "+9 −2" });

  await pushLive(changes([change("src/edited.ts", ".", "M", [0, 0], [10, 2])]));
  expect(treeRow("src/edited.ts")).toMatchObject({ counts: "+10 −2" });
});

it("Tree diff fence: a refresh answer older than the stream's newest value never replaces it", async () => {
  let answerRefresh: (result: unknown) => void = () => {};
  fixture.runQuery = () =>
    new Promise((resolve) => {
      answerRefresh = resolve;
    });
  await mountDiffSurface("tree");
  await clickRefresh();

  // The stream moves on while the forced read is still out.
  await pushLive(changes([change("src/edited.ts", ".", "M", [0, 0], [3, 0])]));
  expect(treeRow("src/edited.ts")).toMatchObject({ counts: "+3" });

  // The forced read then lands with what git said before that change.
  await act(async () =>
    answerRefresh(
      AsyncResult.success(changes([change("src/edited.ts", ".", "M", [0, 0], [2, 0])])),
    ),
  );
  await settle();
  expect(treeRow("src/edited.ts")).toMatchObject({ counts: "+3" });
});

it("Tree diff fence: a nested project opens its own file and declines one outside it", () => {
  const rows = gitChangeRows(
    [
      change("apps/web/shared/x.ts", ".", "M", [0, 0], [1, 0]),
      change("shared/x.ts", ".", "M", [0, 0], [1, 0]),
    ],
    "/repo",
    "/repo/apps/web",
  );
  const rowsByPath = new Map(rows.map((row) => [row.path, row]));
  const openFileSurfaces = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef)
      .surfaces.filter((surface) => surface.kind === "file")
      .map((surface) => surface.id);

  openGitChangeFile(threadRef, rowsByPath, "shared/x.ts");
  expect(openFileSurfaces()).toEqual([]);

  openGitChangeFile(threadRef, rowsByPath, "apps/web/shared/x.ts");
  expect(openFileSurfaces()).toEqual(["file:shared/x.ts"]);
});

/** A working-tree patch with two new files, as the server sends it for Files diff. */
function workingTreePatch(paths: ReadonlyArray<string>, kind = "working-tree") {
  const diff = paths
    .map(
      (path) =>
        `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+hello\n`,
    )
    .join("");
  return {
    cwd: worktreePath,
    generatedAt: now,
    sources: [
      {
        id: kind,
        kind,
        title: kind,
        baseRef: null,
        headRef: null,
        diff,
        diffHash: "fence-working-tree",
        truncated: false,
      },
    ],
  };
}

it("Tree diff fence: Files diff marks an untracked new file untracked and keeps a staged one added", async () => {
  localStorage.setItem("t3code.diffFileTreeOpen", "true");
  fixture.diffPreview = {
    kind: "success",
    value: workingTreePatch(["src/untracked-new.ts", "src/staged-new.ts"]),
  };
  fixture.oneShotChanges = {
    kind: "success",
    value: changes([
      change("src/untracked-new.ts", "?", "?", [0, 0], [1, 0]),
      change("src/staged-new.ts", "A", ".", [1, 0], [0, 0]),
    ]),
  };
  await mountDiffSurface("unstaged");
  expect(selectedMode()).toBe("Files diff");

  expect(treeRow("src/untracked-new.ts")).toMatchObject({ status: "untracked" });
  expect(treeRow("src/staged-new.ts")).toMatchObject({ status: "added" });
});

it("Tree diff fence: Branch changes keeps a new file added and reads no working-tree status", async () => {
  localStorage.setItem("t3code.diffFileTreeOpen", "true");
  fixture.diffPreview = {
    kind: "success",
    value: workingTreePatch(["src/untracked-new.ts"], "branch-range"),
  };
  fixture.oneShotChanges = {
    kind: "success",
    value: changes([change("src/untracked-new.ts", "?", "?", [0, 0], [1, 0])]),
  };
  await mountDiffSurface("branch");
  expect(selectedMode()).toBe("Branch changes");

  expect(treeRow("src/untracked-new.ts")).toMatchObject({ status: "added" });
  expect(requestsFor(WS_METHODS.reviewGetWorkingTreeChanges)).toEqual([]);
});
