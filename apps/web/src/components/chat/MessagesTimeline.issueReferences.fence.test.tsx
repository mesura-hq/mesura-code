// @vitest-environment happy-dom
/**
 * Entry point: the real `MessagesTimeline`, the component ChatView renders for a thread's
 * conversation, mounted inside a memory router on a thread route with the real right-panel
 * store. Its assistant rows render the real `ChatMarkdown` with the thread's ref, so a click on
 * an issue reference here is the click a developer makes on an agent message.
 *
 * The fixture replaces boundaries only: the virtualized list (rendered flat), the project,
 * thread-shell, server-config (hook and atom) and environment hooks, the query runner that sends a read over the
 * connection (every run is recorded and settled by the spec), the Issues query families (every
 * call is recorded), and the external-link opener (every URL it is handed is recorded).
 *
 * Issues pane, phase 3: acceptance criteria 1–7.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { act, createRef, type ReactNode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface RecordedRun {
  family: unknown;
  target: { environmentId: string; input: Record<string, unknown> };
  settle: (result: unknown) => Promise<void>;
}

const fixture = vi.hoisted(() => ({
  projects: [] as Array<unknown>,
  threadShells: new Map<string, unknown>(),
  capabilitiesByEnvironment: new Map<string, Record<string, unknown>>(),
  runs: [] as Array<RecordedRun>,
  issueQueries: [] as Array<{ kind: string; target: unknown }>,
  openedExternally: [] as Array<string>,
  /** Connection phase per environment; absent means connected. */
  connectionPhaseByEnvironment: new Map<string, string>(),
}));

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));
vi.mock("~/state/entities", async (importOriginal) => {
  const shellFor = (ref: { environmentId: string; threadId: string } | null) =>
    ref === null
      ? null
      : (fixture.threadShells.get(`${ref.environmentId}:${ref.threadId}`) ?? null);
  const serverConfigs = () =>
    new Map(
      [...fixture.capabilitiesByEnvironment].map(([environmentId, capabilities]) => [
        environmentId,
        { environment: { capabilities }, availableEditors: [] },
      ]),
    );
  return {
    ...(await importOriginal<typeof import("~/state/entities")>()),
    useProjects: () => fixture.projects,
    useProject: (ref: { environmentId: string; projectId: string } | null) =>
      ref === null
        ? null
        : ((fixture.projects as Array<{ environmentId: string; id: string }>).find(
            (project) =>
              project.environmentId === ref.environmentId && project.id === ref.projectId,
          ) ?? null),
    readProjects: () => fixture.projects,
    useServerConfigs: serverConfigs,
    useThreadShell: shellFor,
    readThreadShell: shellFor,
    useThreadShells: () => [...fixture.threadShells.values()],
    readThreadShells: () => [...fixture.threadShells.values()],
  };
});
vi.mock("~/state/environments", async (importOriginal) => {
  const presentation = (environmentId: string | null) =>
    environmentId === null || !fixture.capabilitiesByEnvironment.has(environmentId)
      ? null
      : {
          environmentId,
          label: environmentId,
          connection: {
            phase: fixture.connectionPhaseByEnvironment.get(environmentId) ?? "connected",
            error: null,
            traceId: null,
          },
          serverConfig: {
            environment: { capabilities: fixture.capabilitiesByEnvironment.get(environmentId) },
          },
        };
  return {
    ...(await importOriginal<typeof import("~/state/environments")>()),
    useEnvironment: presentation,
    useEnvironments: () => ({
      isReady: true,
      networkStatus: "online",
      environments: [...fixture.capabilitiesByEnvironment.keys()].map(presentation),
      presentationById: new Map(
        [...fixture.capabilitiesByEnvironment.keys()].map((id) => [id, presentation(id)]),
      ),
    }),
    usePrimaryEnvironmentId: () => [...fixture.capabilitiesByEnvironment.keys()][0] ?? null,
  };
});
// ChatMarkdown reads its environment's config through this atom family; one atom per id and
// test keeps the subscription stable while it reports the fixture's capabilities.
vi.mock("~/state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/server")>();
  const { Atom } = await import("effect/unstable/reactivity");
  const atoms = new Map<string, unknown>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (environmentId: string | null) => {
        const capabilities =
          environmentId === null ? undefined : fixture.capabilitiesByEnvironment.get(environmentId);
        const key = `${environmentId}:${JSON.stringify(capabilities)}`;
        if (!atoms.has(key)) {
          atoms.set(
            key,
            Atom.make(
              capabilities === undefined
                ? null
                : { environment: { capabilities }, availableEditors: [] },
            ),
          );
        }
        return atoms.get(key);
      },
    },
  };
});
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (family: unknown) => (target: RecordedRun["target"]) =>
    new Promise((resolve) => {
      fixture.runs.push({
        family,
        target,
        settle: async (result) => {
          resolve(result);
          await Promise.resolve();
        },
      });
    }),
}));
vi.mock("~/state/issues", () => {
  const family = (kind: string) =>
    Object.assign(
      (target: unknown) => {
        fixture.issueQueries.push({ kind, target });
        return { kind, target };
      },
      { kind },
    );
  return {
    issueList: family("list"),
    issueDetail: family("detail"),
    issueReference: family("reference"),
  };
});
vi.mock("~/browser/useOpenLink", () => ({
  useOpenLink: () => async (url: string) => {
    fixture.openedExternally.push(url);
  },
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("~/editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));

import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { issueReference } from "~/state/issues";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { MessagesTimeline } from "./MessagesTimeline";

const environmentId = EnvironmentId.make("issue-ref-env");
const otherEnvironmentId = EnvironmentId.make("issue-ref-other-env");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("issue-ref-thread"));
const otherThreadRef = scopeThreadRef(environmentId, ThreadId.make("issue-ref-other-thread"));
const FULL_CAPABILITIES = {
  repositoryIdentity: true,
  pullRequests: true,
  issues: true,
  issueReferences: true,
};

function project(environment: EnvironmentId, id: string, owner: string, name: string) {
  return {
    id: ProjectId.make(id),
    environmentId: environment,
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: {
      canonicalKey: `github.com/${owner}/${name}`,
      provider: "github",
      owner,
      name,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
    },
  };
}

const alpha = project(environmentId, "alpha", "acme", "alpha");
const zetaElsewhere = project(otherEnvironmentId, "zeta", "acme", "zeta");

function threadShell(ref: typeof threadRef, projectId: string | null) {
  return {
    id: ref.threadId,
    environmentId: ref.environmentId,
    projectId,
    title: "Investigate the resume crash",
  };
}

let messageCounter = 0;
function assistantEntry(text: string, options: { streaming?: boolean; id?: string } = {}) {
  const id = options.id ?? `message-${(messageCounter += 1)}`;
  const createdAt = "2026-10-09T10:00:00.000Z";
  return {
    id,
    kind: "message" as const,
    createdAt,
    message: {
      id: MessageId.make(id),
      role: "assistant" as const,
      text,
      turnId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: options.streaming ?? false,
    },
  };
}

function timelineProps(ref: typeof threadRef, entries: Array<ReturnType<typeof assistantEntry>>) {
  return {
    isWorking: false,
    activeTurnStartedAt: null,
    listRef: createRef<never>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaries: [],
    routeThreadKey: scopedThreadKey(ref),
    onOpenTurnDiff: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ref.environmentId,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
    timelineEntries: entries,
  } as unknown as Parameters<typeof MessagesTimeline>[0];
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let router: ReturnType<typeof createRouter> | null = null;
let currentProps: Parameters<typeof MessagesTimeline>[0] | null = null;
const propsListeners = new Set<() => void>();

/** The route's component: re-renders whenever a spec hands the timeline new props. */
function TimelineHost() {
  const props = useSyncExternalStore(
    (listener) => {
      propsListeners.add(listener);
      return () => propsListeners.delete(listener);
    },
    () => currentProps,
  );
  return props === null ? null : <MessagesTimeline {...props} />;
}

const THREAD_PATH = "/issue-ref-env/issue-ref-thread";

async function mountTimeline(
  entries: Array<ReturnType<typeof assistantEntry>>,
  ref: typeof threadRef = threadRef,
) {
  currentProps = timelineProps(ref, entries);
  const shell = createRootRoute({
    component: TimelineHost,
  });
  router = createRouter({
    routeTree: shell,
    history: createMemoryHistory({ initialEntries: [THREAD_PATH] }),
  }) as never;
  await act(async () => {
    await router!.load();
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router as never} />
      </AppAtomRegistryProvider>,
    );
  });
}

async function updateTimeline(
  entries: Array<ReturnType<typeof assistantEntry>>,
  ref: typeof threadRef = threadRef,
) {
  await act(async () => {
    currentProps = timelineProps(ref, entries);
    for (const listener of propsListeners) listener();
  });
}

function anchors() {
  return Array.from(container!.querySelectorAll<HTMLAnchorElement>("a"));
}

function anchorTo(href: string, nth = 0) {
  const found = anchors().filter((anchor) => anchor.getAttribute("href") === href)[nth];
  if (!found) {
    throw new Error(
      `No link to ${href}; rendered: ${anchors()
        .map((anchor) => anchor.getAttribute("href"))
        .join(", ")}`,
    );
  }
  return found;
}

/** Returns whether the click kept its default action, i.e. stayed an ordinary link. */
async function activate(
  anchor: HTMLAnchorElement,
  init: MouseEventInit = {},
): Promise<{ followedAsLink: boolean }> {
  let followedAsLink = true;
  await act(async () => {
    followedAsLink = anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
  return { followedAsLink };
}

function referenceRuns() {
  return fixture.runs.filter((run) => run.family === issueReference);
}

function pullRequestDetailRuns() {
  return fixture.runs.filter((run) => run.family === pullRequestEnvironment.detail);
}

function success(value: unknown) {
  return { _tag: "Success", value };
}

function failure(message: string) {
  return { _tag: "Failure", cause: Cause.fail(new Error(message)) };
}

function issueResolution(number: number, repository = "acme/alpha") {
  return success({
    kind: "issue",
    number,
    url: `https://github.com/${repository}/issues/${number}`,
    repository,
  });
}

function pullRequestResolution(number: number, repository = "acme/alpha") {
  return success({
    kind: "pull-request",
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    repository,
  });
}

async function settle(run: RecordedRun | undefined, result: unknown) {
  if (!run) throw new Error("Expected a classification read");
  await act(async () => {
    await run.settle(result);
    // The click handler chains on the read; let every continuation land.
    for (let round = 0; round < 5; round += 1) await Promise.resolve();
  });
}

function panelState(ref: typeof threadRef = threadRef) {
  return selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
}

function issuesSurface(ref: typeof threadRef = threadRef) {
  return panelState(ref).surfaces.find(
    (surface): surface is Extract<RightPanelSurface, { kind: "issues" }> =>
      surface.kind === "issues",
  );
}

function pullRequestSurfaces(ref: typeof threadRef = threadRef) {
  return panelState(ref).surfaces.filter((surface) => surface.kind === "pull-request");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  messageCounter = 0;
  fixture.projects = [alpha, zetaElsewhere];
  fixture.threadShells = new Map([
    [scopedThreadKey(threadRef), threadShell(threadRef, alpha.id)],
    [scopedThreadKey(otherThreadRef), threadShell(otherThreadRef, alpha.id)],
  ]);
  fixture.capabilitiesByEnvironment = new Map([
    [environmentId, FULL_CAPABILITIES],
    [otherEnvironmentId, FULL_CAPABILITIES],
  ]);
  fixture.runs = [];
  fixture.issueQueries = [];
  fixture.openedExternally = [];
  fixture.connectionPhaseByEnvironment = new Map();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  router = null;
  vi.unstubAllGlobals();
});

describe("Issue references in agent messages: activation opens the integrated Issues surface", () => {
  it("issues phase 3 fence: clicking a registered issue URL opens that issue beside the thread without leaving the route", async () => {
    await mountTimeline([
      assistantEntry("The crash is tracked in https://github.com/acme/alpha/issues/7 upstream."),
    ]);
    const link = anchorTo("https://github.com/acme/alpha/issues/7");

    const { followedAsLink } = await activate(link);
    expect(followedAsLink).toBe(false);
    expect(referenceRuns().map((run) => run.target)).toEqual([
      { environmentId, input: { projectId: alpha.id, number: 7 } },
    ]);
    await settle(referenceRuns()[0], issueResolution(7));

    expect(panelState().isOpen).toBe(true);
    expect(panelState().activeSurfaceId).toBe("issues");
    expect(issuesSurface()).toMatchObject({ selection: { projectId: alpha.id, number: 7 } });
    expect(router!.state.location.pathname).toBe(THREAD_PATH);
    expect(fixture.openedExternally).toEqual([]);
  });

  it("issues phase 3 fence: keyboard activation of an issue URL opens the same issue", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7.")]);
    // Enter on a focused link dispatches a click whose detail is 0.
    const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/issues/7"), {
      detail: 0,
    });
    expect(followedAsLink).toBe(false);
    await settle(referenceRuns()[0], issueResolution(7));

    expect(issuesSurface()).toMatchObject({ selection: { projectId: alpha.id, number: 7 } });
    expect(router!.state.location.pathname).toBe(THREAD_PATH);
  });

  it("issues phase 3 fence: an explicit issue-number reference in agent prose links to the thread project's repository", async () => {
    await mountTimeline([assistantEntry("This regressed in #7, see the notes there.")]);
    const link = anchorTo("https://github.com/acme/alpha/issues/7");
    expect(link.textContent).toBe("#7");

    await activate(link);
    expect(referenceRuns().map((run) => run.target)).toEqual([
      { environmentId, input: { projectId: alpha.id, number: 7 } },
    ]);
    await settle(referenceRuns()[0], issueResolution(7));

    expect(issuesSurface()).toMatchObject({ selection: { projectId: alpha.id, number: 7 } });
  });

  it("issues phase 3 fence: code, authored links and document fragments keep their meaning beside a linked reference", async () => {
    await mountTimeline([
      assistantEntry(
        "Run `git log #3`, read [the notes #4](https://example.com/notes), jump to [section #5](#5), then fix #6.",
      ),
    ]);

    expect(container!.querySelector("code")?.textContent).toBe("git log #3");
    expect(anchors().map((anchor) => anchor.getAttribute("href"))).toEqual([
      "https://example.com/notes",
      "#5",
      "https://github.com/acme/alpha/issues/6",
    ]);
  });

  it("issues phase 3 guard: without a known repository context a short reference stays plain text", async () => {
    fixture.threadShells.set(scopedThreadKey(threadRef), threadShell(threadRef, null));
    await mountTimeline([assistantEntry("This regressed in #7.")]);

    expect(anchors()).toEqual([]);
    expect(container!.textContent).toContain("This regressed in #7.");
  });
});

describe("Issue references in agent messages: authoritative issue and pull request classification", () => {
  it("issues phase 3 fence: a short reference GitHub classifies as a pull request opens the pull request surface", async () => {
    await mountTimeline([assistantEntry("Fixed by #9.")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/9"));
    await settle(referenceRuns()[0], pullRequestResolution(9));

    expect(issuesSurface()).toBeUndefined();
    expect(pullRequestSurfaces()).toEqual([
      expect.objectContaining({ kind: "pull-request", projectId: alpha.id, number: 9 }),
    ]);
    expect(fixture.openedExternally).toEqual([]);
  });

  it("issues phase 3 fence: an issues URL that names a pull request opens the pull request surface", async () => {
    await mountTimeline([assistantEntry("Read https://github.com/acme/alpha/issues/17404 first.")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/17404"));
    await settle(referenceRuns()[0], pullRequestResolution(17404));

    expect(issuesSurface()).toBeUndefined();
    expect(pullRequestSurfaces()).toEqual([
      expect.objectContaining({ kind: "pull-request", number: 17404 }),
    ]);
  });

  it("issues phase 3 guard: a pull request URL opens the pull request surface without an issue classification", async () => {
    await mountTimeline([assistantEntry("Review https://github.com/acme/alpha/pull/9 please.")]);
    const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/pull/9"));

    expect(followedAsLink).toBe(false);
    expect(referenceRuns()).toEqual([]);
    expect(pullRequestSurfaces()).toEqual([
      expect.objectContaining({ kind: "pull-request", number: 9 }),
    ]);
  });

  it("issues phase 3 fence: without reference resolution a short reference keeps the pull request confirmation and never guesses an issue", async () => {
    fixture.capabilitiesByEnvironment.set(environmentId, {
      repositoryIdentity: true,
      pullRequests: true,
      issues: true,
    });
    await mountTimeline([assistantEntry("Fixed by #9.")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/9"));

    expect(referenceRuns()).toEqual([]);
    expect(pullRequestDetailRuns()).toHaveLength(1);
    await settle(pullRequestDetailRuns()[0], failure("Not a pull request"));

    expect(issuesSurface()).toBeUndefined();
    expect(fixture.openedExternally).toEqual(["https://github.com/acme/alpha/issues/9"]);
  });
});

describe("Issue references in agent messages: routing stays inside the thread's environment", () => {
  it("issues phase 3 guard: an issue URL of an unregistered repository stays an ordinary external link", async () => {
    await mountTimeline([assistantEntry("Upstream bug: https://github.com/cli/cli/issues/7")]);
    const { followedAsLink } = await activate(anchorTo("https://github.com/cli/cli/issues/7"));

    expect(followedAsLink).toBe(true);
    expect(fixture.runs).toEqual([]);
    expect(panelState().surfaces).toEqual([]);
  });

  it("issues phase 3 guard: an issue URL registered only on another environment stays an ordinary external link", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/zeta/issues/3")]);
    const { followedAsLink } = await activate(anchorTo("https://github.com/acme/zeta/issues/3"));

    expect(followedAsLink).toBe(true);
    expect(fixture.runs).toEqual([]);
    expect(panelState().surfaces).toEqual([]);
  });

  it("issues phase 3 guard: an environment that cannot resolve references keeps an issue URL an ordinary external link", async () => {
    fixture.capabilitiesByEnvironment.set(environmentId, {
      repositoryIdentity: true,
      pullRequests: true,
      issues: true,
    });
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/issues/7"));

    expect(followedAsLink).toBe(true);
    expect(fixture.runs).toEqual([]);
    expect(panelState().surfaces).toEqual([]);
  });
});

describe("Issue references in agent messages: a disconnected environment", () => {
  it("issues phase 3 regression: a stale reference capability on a disconnected environment sends no read and keeps the original link", async () => {
    fixture.connectionPhaseByEnvironment.set(environmentId, "reconnecting");
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/issues/7"));

    expect(followedAsLink).toBe(true);
    expect(referenceRuns()).toEqual([]);
    expect(panelState().surfaces).toEqual([]);
  });
});

describe("Issue references in agent messages: newer panel choices win (rework)", () => {
  it("issues phase 3 regression: a file opened while an issue is classifying keeps the panel", async () => {
    await mountTimeline([
      assistantEntry(
        "See https://github.com/acme/alpha/issues/7 and [README.md](/work/alpha/README.md)",
      ),
    ]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    // The file chip the agent message renders for its README link.
    const readme = container!.querySelector<HTMLAnchorElement>('a[href$="README.md"]');
    expect(readme).not.toBeNull();
    await activate(readme!);
    const fileSurfaceId = panelState().activeSurfaceId;
    expect(fileSurfaceId).toMatch(/^file:/);

    await settle(referenceRuns()[0], issueResolution(7));

    expect(panelState().activeSurfaceId).toBe(fileSurfaceId);
    expect(issuesSurface()).toBeUndefined();
    expect(fixture.openedExternally).toEqual([]);
  });

  it("issues phase 3 regression: closing the panel while an issue is classifying keeps it closed", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    act(() => useRightPanelStore.getState().open(threadRef, "diff"));
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    act(() => useRightPanelStore.getState().close(threadRef));

    await settle(referenceRuns()[0], failure("GitHub API rate limit exceeded."));
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    act(() => useRightPanelStore.getState().close(threadRef));
    await settle(referenceRuns()[1], issueResolution(7));

    expect(panelState().isOpen).toBe(false);
    expect(issuesSurface()).toBeUndefined();
    // A stale failure is not followed either: the reader moved on.
    expect(fixture.openedExternally).toEqual([]);
  });

  it("issues phase 3 regression: an automatic panel update does not cancel a pending issue choice", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    act(() => {
      const store = useRightPanelStore.getState();
      store.openProactive(
        threadRef,
        { id: "diff", kind: "diff" },
        store.getUserActionRevision(threadRef),
      );
    });

    await settle(referenceRuns()[0], issueResolution(7));

    expect(issuesSurface()).toMatchObject({ selection: { number: 7 } });
    expect(panelState().activeSurfaceId).toBe("issues");
  });
});

describe("Issue references in agent messages: unavailable environments keep shorthand ordinary (rework)", () => {
  for (const [label, capabilities] of [
    ["a current server", FULL_CAPABILITIES],
    [
      "an older server without reference resolution",
      { repositoryIdentity: true, pullRequests: true, issues: true },
    ],
  ] as const) {
    it(`issues phase 3 regression: a short reference on a disconnected environment with ${label} stays an ordinary link`, async () => {
      fixture.capabilitiesByEnvironment.set(environmentId, capabilities);
      fixture.connectionPhaseByEnvironment.set(environmentId, "reconnecting");
      await mountTimeline([assistantEntry("This regressed in #7.")]);
      const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/issues/7"));

      expect(followedAsLink).toBe(true);
      expect(fixture.runs).toEqual([]);
      expect(panelState().surfaces).toEqual([]);
    });
  }
});

describe("Direct pull request links keep every modifier ordinary (rework)", () => {
  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    it(`issues phase 3 regression: a ${modifier} click on a direct pull request link stays an ordinary link`, async () => {
      await mountTimeline([assistantEntry("Review https://github.com/acme/alpha/pull/9 please.")]);
      const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/pull/9"), {
        [modifier]: true,
      });

      expect(followedAsLink).toBe(true);
      expect(fixture.runs).toEqual([]);
      expect(panelState().surfaces).toEqual([]);
    });
  }
});

describe("Issue references in agent messages: modifiers and rapid activation", () => {
  it("issues phase 3 fence: a modified click on an issue URL stays an ordinary external link", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7 and #8.")]);
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      for (const href of [
        "https://github.com/acme/alpha/issues/7",
        "https://github.com/acme/alpha/issues/8",
      ]) {
        const { followedAsLink } = await activate(anchorTo(href), { [modifier]: true });
        expect(followedAsLink, `${modifier} on ${href}`).toBe(true);
      }
    }

    expect(fixture.runs).toEqual([]);
    expect(panelState().surfaces).toEqual([]);
  });

  it("issues phase 3 fence: the most recently activated issue stays visible when an earlier read answers last", async () => {
    await mountTimeline([
      assistantEntry("First: https://github.com/acme/alpha/issues/7"),
      assistantEntry("Second: https://github.com/acme/alpha/issues/8"),
    ]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    await activate(anchorTo("https://github.com/acme/alpha/issues/8"));
    const [first, second] = referenceRuns();

    await settle(second, issueResolution(8));
    await settle(first, issueResolution(7));

    expect(issuesSurface()).toMatchObject({ selection: { number: 8 } });
  });

  it("issues phase 3 fence: an earlier pull request answer cannot replace a later issue choice", async () => {
    await mountTimeline([
      assistantEntry("First: #9"),
      assistantEntry("Second: https://github.com/acme/alpha/issues/8"),
    ]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/9"));
    await activate(anchorTo("https://github.com/acme/alpha/issues/8"));
    const [first, second] = referenceRuns();

    await settle(second, issueResolution(8));
    await settle(first, pullRequestResolution(9));

    expect(pullRequestSurfaces()).toEqual([]);
    expect(issuesSurface()).toMatchObject({ selection: { number: 8 } });
    expect(panelState().activeSurfaceId).toBe("issues");
  });

  it("issues phase 3 regression: a pull request link followed while an issue is classifying is not replaced by the older answer", async () => {
    await mountTimeline([
      assistantEntry("First: https://github.com/acme/alpha/issues/7"),
      assistantEntry("Second: https://github.com/acme/alpha/pull/9"),
    ]);
    // The Issues pane is already open beside the thread.
    act(() => useRightPanelStore.getState().open(threadRef, "issues"));
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/pull/9"));
    expect(followedAsLink).toBe(false);
    const pullRequest = pullRequestSurfaces()[0];
    expect(pullRequest).toMatchObject({ number: 9 });

    await settle(referenceRuns()[0], issueResolution(7));

    expect(panelState().activeSurfaceId).toBe(pullRequest?.id);
    expect(issuesSurface()).toEqual({ id: "issues", kind: "issues" });
    expect(fixture.openedExternally).toEqual([]);
  });

  it("issues phase 3 regression: a modified pull request click leaves a pending issue choice in place", async () => {
    await mountTimeline([
      assistantEntry("First: https://github.com/acme/alpha/issues/7"),
      assistantEntry("Second: https://github.com/acme/alpha/pull/9"),
    ]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/pull/9"), {
      ctrlKey: true,
    });
    expect(followedAsLink).toBe(true);

    await settle(referenceRuns()[0], issueResolution(7));

    expect(pullRequestSurfaces()).toEqual([]);
    expect(issuesSurface()).toMatchObject({ selection: { number: 7 } });
  });

  it("issues phase 3 fence: a read that answers after the thread changed opens nothing", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    await updateTimeline([assistantEntry("Another thread.")], otherThreadRef);
    await settle(referenceRuns()[0], issueResolution(7));

    expect(panelState(threadRef).surfaces).toEqual([]);
    expect(panelState(otherThreadRef).surfaces).toEqual([]);
    expect(fixture.openedExternally).toEqual([]);
  });

  it("issues phase 3 fence: a read that answers after the conversation unmounted opens nothing", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    act(() => root?.unmount());
    root = null;
    await settle(referenceRuns()[0], issueResolution(7));

    expect(panelState().surfaces).toEqual([]);
    expect(fixture.openedExternally).toEqual([]);
  });
});

describe("Issue references in agent messages: boundaries the phase learned (regression)", () => {
  it("issues phase 3 regression: the pane consuming an earlier selection does not cancel a newer pending reference", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    act(() =>
      useRightPanelStore.getState().openIssue(threadRef, { projectId: alpha.id, number: 5 }),
    );
    const earlier = issuesSurface()?.selection?.requestId;
    if (earlier === undefined) throw new Error("Expected the earlier issue selection to be open");
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    // ChatView records that the pane showed the earlier choice: an automatic update.
    act(() => useRightPanelStore.getState().consumeIssueSelection(threadRef, earlier));

    await settle(referenceRuns()[0], issueResolution(7));

    expect(issuesSurface()).toMatchObject({ selection: { number: 7 } });
    expect(panelState().activeSurfaceId).toBe("issues");
  });

  it("issues phase 3 regression: a panel choice in another thread does not cancel this thread's pending reference", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    act(() => useRightPanelStore.getState().openFile(otherThreadRef, "README.md"));

    await settle(referenceRuns()[0], issueResolution(7));

    expect(issuesSurface()).toMatchObject({ selection: { number: 7 } });
    expect(panelState(otherThreadRef).activeSurfaceId).toBe("file:README.md");
  });

  it("issues phase 3 regression: an older message leaving the timeline does not cancel a newer message's pending reference", async () => {
    const older = assistantEntry("First: https://github.com/acme/alpha/issues/7", { id: "older" });
    const newer = assistantEntry("Second: https://github.com/acme/alpha/issues/8", { id: "newer" });
    await mountTimeline([older, newer]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    await activate(anchorTo("https://github.com/acme/alpha/issues/8"));
    const [first, second] = referenceRuns();
    await updateTimeline([newer]);

    await settle(second, issueResolution(8));
    await settle(first, issueResolution(7));

    expect(issuesSurface()).toMatchObject({ selection: { number: 8 } });
  });

  it("issues phase 3 regression: a streaming message keeps short references as text until it settles", async () => {
    const id = "settling-message";
    await mountTimeline([
      assistantEntry("Tracking https://github.com/acme/alpha/issues/7 and #8 so far", {
        streaming: true,
        id,
      }),
    ]);
    // The URL is a link while streaming; the shorthand waits, so incremental parsing stays on.
    expect(anchors().map((anchor) => anchor.getAttribute("href"))).toEqual([
      "https://github.com/acme/alpha/issues/7",
    ]);

    await updateTimeline([
      assistantEntry("Tracking https://github.com/acme/alpha/issues/7 and #8 so far", { id }),
    ]);

    expect(anchors().map((anchor) => anchor.getAttribute("href"))).toEqual([
      "https://github.com/acme/alpha/issues/7",
      "https://github.com/acme/alpha/issues/8",
    ]);
    expect(fixture.runs).toEqual([]);
  });

  it("issues phase 3 regression: a recorded identity naming two repositories links no short reference", async () => {
    fixture.projects = [
      { ...alpha, repositoryIdentity: { ...alpha.repositoryIdentity, owner: "someone-else" } },
      zetaElsewhere,
    ];
    await mountTimeline([assistantEntry("This regressed in #7.")]);

    expect(anchors()).toEqual([]);
    expect(container!.textContent).toContain("This regressed in #7.");
  });
});

describe("Issue references in agent messages: canonical-only identities (repair)", () => {
  const canonicalOnly = () => {
    const { owner: _owner, name: _name, ...identity } = alpha.repositoryIdentity;
    return { ...alpha, repositoryIdentity: identity };
  };

  it("issues phase 3 repair: a short reference in a canonical-only GitHub project opens its issue", async () => {
    fixture.projects = [canonicalOnly(), zetaElsewhere];
    await mountTimeline([assistantEntry("This regressed in #7.")]);
    const { followedAsLink } = await activate(anchorTo("https://github.com/acme/alpha/issues/7"));

    expect(followedAsLink).toBe(false);
    expect(referenceRuns().map((run) => run.target)).toEqual([
      { environmentId, input: { projectId: alpha.id, number: 7 } },
    ]);
    await settle(referenceRuns()[0], issueResolution(7));
    expect(issuesSurface()).toMatchObject({ selection: { projectId: alpha.id, number: 7 } });
  });

  it("issues phase 3 repair: a short reference GitHub classifies as a pull request opens it in a canonical-only project", async () => {
    fixture.projects = [canonicalOnly(), zetaElsewhere];
    await mountTimeline([assistantEntry("Fixed by #9.")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/9"));
    await settle(referenceRuns()[0], pullRequestResolution(9));

    expect(issuesSurface()).toBeUndefined();
    expect(pullRequestSurfaces()).toEqual([
      expect.objectContaining({ kind: "pull-request", projectId: alpha.id, number: 9 }),
    ]);
    expect(fixture.openedExternally).toEqual([]);
  });

  it("issues phase 3 repair: an issue URL naming one of two repositories in a contradictory identity stays an ordinary link", async () => {
    fixture.projects = [
      { ...alpha, repositoryIdentity: { ...alpha.repositoryIdentity, name: "other" } },
      zetaElsewhere,
    ];
    await mountTimeline([
      assistantEntry(
        "See https://github.com/acme/other/issues/7 and https://github.com/acme/alpha/issues/7",
      ),
    ]);
    for (const href of [
      "https://github.com/acme/other/issues/7",
      "https://github.com/acme/alpha/issues/7",
    ]) {
      const { followedAsLink } = await activate(anchorTo(href));
      expect(followedAsLink, href).toBe(true);
    }
    expect(fixture.runs).toEqual([]);
    expect(panelState().surfaces).toEqual([]);
  });
});

describe("Issue references in agent messages: rendering is not activation", () => {
  it("issues phase 3 fence: rendering and streaming issue mentions sends no read and opens nothing", async () => {
    const id = "streaming-message";
    await mountTimeline([
      assistantEntry("Tracking https://github.com/acme/alpha/issues/7 and #", {
        streaming: true,
        id,
      }),
    ]);
    await updateTimeline([
      assistantEntry("Tracking https://github.com/acme/alpha/issues/7 and #8 and", {
        streaming: true,
        id,
      }),
    ]);
    await updateTimeline([
      assistantEntry("Tracking https://github.com/acme/alpha/issues/7 and #8 and #9.", { id }),
    ]);

    expect(anchors().length).toBeGreaterThanOrEqual(3);
    expect(fixture.runs).toEqual([]);
    expect(fixture.issueQueries).toEqual([]);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });
});

describe("Issue references in agent messages: failures keep the original link", () => {
  it("issues phase 3 fence: a classification read failure opens the original link and no surface", async () => {
    await mountTimeline([assistantEntry("See https://github.com/acme/alpha/issues/7")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    await settle(
      referenceRuns()[0],
      failure("GitHub CLI is not authenticated. Run gh auth login."),
    );

    expect(panelState().surfaces).toEqual([]);
    expect(fixture.openedExternally).toEqual(["https://github.com/acme/alpha/issues/7"]);
  });

  it("issues phase 3 fence: a classification naming another repository or number is never substituted", async () => {
    await mountTimeline([
      assistantEntry(
        "See https://github.com/acme/alpha/issues/7 and https://github.com/acme/alpha/issues/5",
      ),
    ]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    await settle(referenceRuns()[0], issueResolution(7, "acme/other"));
    await activate(anchorTo("https://github.com/acme/alpha/issues/5"));
    await settle(referenceRuns()[1], issueResolution(6));

    expect(panelState().surfaces).toEqual([]);
    expect(fixture.openedExternally).toEqual([
      "https://github.com/acme/alpha/issues/7",
      "https://github.com/acme/alpha/issues/5",
    ]);
  });

  it("issues phase 3 fence: after a failure the same reference can be followed again", async () => {
    await mountTimeline([assistantEntry("See #7")]);
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    await settle(referenceRuns()[0], failure("GitHub API rate limit exceeded."));
    await activate(anchorTo("https://github.com/acme/alpha/issues/7"));
    await settle(referenceRuns()[1], issueResolution(7));

    expect(issuesSurface()).toMatchObject({ selection: { projectId: alpha.id, number: 7 } });
  });
});

describe("Issue references in agent messages: ordinary links keep their behavior", () => {
  it("issues phase 3 guard: an ordinary web link in an agent message is not intercepted", async () => {
    await mountTimeline([assistantEntry("Docs: https://example.com/guide")]);
    const { followedAsLink } = await activate(anchorTo("https://example.com/guide"));

    expect(followedAsLink).toBe(true);
    expect(fixture.runs).toEqual([]);
    expect(panelState().surfaces).toEqual([]);
  });
});
