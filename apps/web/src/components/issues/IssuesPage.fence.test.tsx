// @vitest-environment happy-dom
/**
 * Entry points: the real `/_chat/issues` file route (`routes/_chat.issues.tsx`), mounted at
 * `/issues` the way `routeTree.gen.ts` mounts it, and the real `ThreadIssuesPanel`, the pane
 * entry `ChatView` renders for the `issues` right-panel surface. Both render the real
 * `IssuesPage`.
 *
 * The fixture replaces the boundaries only: the environment and project hooks, and the
 * `issueList` / `issueDetail` query families. Every call to a query family is recorded, so a
 * spec can prove that no issue RPC was ever created for an environment that has not said it
 * supports Issues.
 *
 * Issues pane, phase 2: acceptance criteria 3–7.
 */
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  type IssueDetail,
  type IssueDetailInput,
  type IssueListInput,
  type IssueListResult,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface FixtureEnvironment {
  environmentId: string;
  label: string;
  connection: { phase: string; error: null; traceId: null };
  serverConfig: { environment: { capabilities: Record<string, unknown> } } | null;
}

const fixture = vi.hoisted(() => ({
  environments: [] as Array<FixtureEnvironment>,
  projects: [] as Array<unknown>,
  /** Every issue query the page created, in order. */
  requests: [] as Array<{ kind: "list" | "detail"; environmentId: string; input: unknown }>,
  listResult: null as unknown,
  detailResult: null as unknown,
  /** Whether the detail read is still in flight. */
  detailPending: false,
  /** Whether every environment has delivered its project snapshot. */
  projectsKnown: true,
}));

vi.mock("~/state/environments", async (importOriginal) => {
  const find = (environmentId: string | null) =>
    fixture.environments.find((environment) => environment.environmentId === environmentId) ?? null;
  return {
    ...(await importOriginal<typeof import("~/state/environments")>()),
    useEnvironments: () => ({
      isReady: true,
      networkStatus: "online",
      environments: fixture.environments,
      presentationById: new Map(
        fixture.environments.map((environment) => [environment.environmentId, environment]),
      ),
    }),
    useEnvironment: (environmentId: string | null) => find(environmentId),
    usePrimaryEnvironmentId: () => fixture.environments[0]?.environmentId ?? null,
    usePrimaryEnvironment: () => fixture.environments[0] ?? null,
  };
});
vi.mock("~/state/presentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/presentation")>()),
  useEnvironmentPresentation: (environmentId: string | null) => ({
    isReady: true,
    presentation:
      fixture.environments.find((environment) => environment.environmentId === environmentId) ??
      null,
  }),
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useProjects: () => fixture.projects,
  useServerConfigs: () =>
    new Map(
      fixture.environments.flatMap((environment) =>
        environment.serverConfig ? [[environment.environmentId, environment.serverConfig]] : [],
      ),
    ),
  useAllEnvironmentShellsBootstrapped: () => fixture.projectsKnown,
}));
vi.mock("~/state/issues", () => ({
  issueList: (args: { environmentId: string; input: unknown }) => {
    fixture.requests.push({ kind: "list", ...args });
    return { kind: "list", ...args };
  },
  issueDetail: (args: { environmentId: string; input: unknown }) => {
    fixture.requests.push({ kind: "detail", ...args });
    return { kind: "detail", ...args };
  },
}));
vi.mock("~/state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/query")>()),
  useEnvironmentQuery: (atom: { kind: "list" | "detail" } | null) => ({
    data: atom === null ? null : atom.kind === "list" ? fixture.listResult : fixture.detailResult,
    error: null,
    isPending: atom !== null && atom.kind === "detail" && fixture.detailPending,
    isSuccess: atom !== null,
    refresh: () => undefined,
  }),
}));

// The markdown renderer is the PR surface's, tested there; it needs a live connection to resolve
// remote links, which this fixture does not model.
vi.mock("~/components/pullRequest/PullRequestMarkdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/pullRequest/PullRequestMarkdown")>()),
  PullRequestMarkdown: ({ text }: { text: string }) => <div data-markdown>{text}</div>,
}));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { Route as IssuesRoute } from "~/routes/_chat.issues";
import { ThreadIssuesPanel } from "./ThreadIssuesPanel";

const supportedEnvironmentId = EnvironmentId.make("issues-fence-current");
const olderEnvironmentId = EnvironmentId.make("issues-fence-older");

function environment(
  environmentId: string,
  options: { phase?: string; capabilities?: Record<string, unknown> | null } = {},
): FixtureEnvironment {
  const capabilities = options.capabilities === undefined ? { issues: true } : options.capabilities;
  return {
    environmentId,
    label: environmentId,
    connection: { phase: options.phase ?? "connected", error: null, traceId: null },
    serverConfig:
      capabilities === null
        ? null
        : {
            environment: {
              capabilities: { repositoryIdentity: true, pullRequests: true, ...capabilities },
            },
          },
  };
}

function project(environmentId: string, id: string, title: string): EnvironmentProject {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    title,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: {
      canonicalKey: `github.com/acme/${id}`,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
      provider: "github",
      owner: "acme",
      name: id,
      webUrl: `https://github.com/acme/${id}`,
    },
  } as unknown as EnvironmentProject;
}

function keyOf(candidate: EnvironmentProject) {
  return scopedProjectKey(scopeProjectRef(candidate.environmentId, candidate.id));
}

const ISSUE_SEVEN: IssueDetail = {
  number: 7,
  title: "Crash on resume",
  url: "https://github.com/acme/alpha/issues/7",
  state: "OPEN",
  // GitHub reports a deleted account as an empty login.
  author: { login: "" },
  assignees: [{ login: "bob" }],
  labels: [{ name: "bug", color: "d73a4a" }],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  body: "Steps to reproduce the resume crash",
  comments: [
    {
      id: "comment-1",
      author: null,
      body: "Same crash after suspend",
      createdAt: "2026-10-03T00:00:00Z",
      url: "https://github.com/acme/alpha/issues/7#issuecomment-1",
    },
  ],
};

function listResult(): IssueListResult {
  const { body: _body, comments: _comments, ...summary } = ISSUE_SEVEN;
  return {
    repository: "acme/alpha",
    repositoryUrl: "https://github.com/acme/alpha",
    issues: [
      summary,
      {
        ...summary,
        number: 8,
        title: "Sidebar overflows",
        author: { login: "alice" },
        labels: [],
      },
    ],
    hasMore: true,
  };
}

let root: Root | null = null;
let activeRouter: {
  latestLoadPromise: Promise<void> | undefined;
  state: { status: string };
} | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<AppAtomRegistryProvider>{element}</AppAtomRegistryProvider>);
  });
}

function rerender(element: React.ReactElement) {
  act(() => {
    root!.render(<AppAtomRegistryProvider>{element}</AppAtomRegistryProvider>);
  });
}

async function mountIssuesRoute(search: Record<string, string | number> = {}) {
  const shell = createRootRoute({ component: () => <Outlet /> });
  const issues = (IssuesRoute as unknown as ReturnType<typeof createRoute>).update({
    id: "/issues",
    path: "/issues",
    getParentRoute: () => shell,
  } as never);
  const query = new URLSearchParams(
    Object.entries(search).map(([key, value]) => [key, String(value)]),
  ).toString();
  const router = createRouter({
    routeTree: shell.addChildren([issues as never]),
    history: createMemoryHistory({ initialEntries: [`/issues${query ? `?${query}` : ""}`] }),
  });
  activeRouter = router as never;
  await act(async () => {
    await router.load();
  });
  mount(<RouterProvider router={router as never} />);
  await settleRouter();
  return router;
}

function text() {
  return container?.textContent ?? "";
}

function buttonNamed(name: RegExp) {
  const button = Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      name.test(candidate.getAttribute("aria-label") ?? "") ||
      name.test(candidate.textContent ?? ""),
  );
  if (!button) throw new Error(`No button named ${name}`);
  return button;
}

/** Waits for a search-param navigation to commit; the thread pane has no router and returns at once. */
async function settleRouter() {
  for (let round = 0; round < 20; round += 1) {
    await act(async () => {
      await activeRouter?.latestLoadPromise;
      await Promise.resolve();
    });
    if (!activeRouter || activeRouter.state.status === "idle") return;
  }
}

async function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settleRouter();
}

function listRequests() {
  return fixture.requests.filter((request) => request.kind === "list");
}

function detailRequests() {
  return fixture.requests.filter((request) => request.kind === "detail");
}

const alpha = project(supportedEnvironmentId, "alpha", "alpha");
const legacy = project(olderEnvironmentId, "legacy", "legacy");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.environments = [environment(supportedEnvironmentId)];
  fixture.projects = [alpha];
  fixture.requests = [];
  fixture.listResult = listResult();
  fixture.detailResult = ISSUE_SEVEN;
  fixture.detailPending = false;
  fixture.projectsKnown = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  activeRouter = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Issues fence: neutral project selection on the standalone page", () => {
  it("issues fence: the standalone page picks the same default project whatever its title", async () => {
    const second = project(supportedEnvironmentId, "beta", "mesura-code");
    fixture.projects = [alpha, second];
    await mountIssuesRoute();
    const withSpecialTitle = listRequests().at(-1)?.input as IssueListInput | undefined;
    act(() => root?.unmount());
    container?.remove();

    fixture.requests = [];
    fixture.projects = [alpha, { ...second, title: "zeta" }];
    await mountIssuesRoute();
    const withPlainTitle = listRequests().at(-1)?.input as IssueListInput | undefined;

    // A title is a display name, never a repository choice.
    expect(withSpecialTitle?.projectId).toBe(withPlainTitle?.projectId);
  });

  it("issues fence: a URL project that cannot be read is explained, not replaced by another repository", async () => {
    fixture.environments = [
      environment(supportedEnvironmentId),
      environment(olderEnvironmentId, { capabilities: {} }),
    ];
    fixture.projects = [alpha, legacy];
    await mountIssuesRoute({ project: keyOf(legacy) });

    expect(fixture.requests).toEqual([]);
    expect(text()).toMatch(/unavailable|not available|isn.t available|cannot|can.t/i);
  });

  it("issues fence: an unknown URL project is explained, not replaced by another repository", async () => {
    await mountIssuesRoute({ project: "issues-fence-gone:deleted-project" });

    expect(fixture.requests).toEqual([]);
    expect(text()).toMatch(
      /unavailable|not available|isn.t available|no longer|not found|cannot|can.t/i,
    );
  });
});

describe("Issues fence: capability and connection gate every issue read", () => {
  it("issues fence: a direct issue URL on an older server shows an unavailable state and sends no issue RPC", async () => {
    fixture.environments = [environment(olderEnvironmentId, { capabilities: {} })];
    fixture.projects = [legacy];
    await mountIssuesRoute({ project: keyOf(legacy), issue: 7 });

    expect(fixture.requests).toEqual([]);
    expect(text()).toMatch(/update|upgrade|does not support|doesn.t support|older/i);
  });

  it("issues fence: the thread pane on an older server shows an unavailable state and sends no issue RPC", async () => {
    fixture.environments = [environment(olderEnvironmentId, { capabilities: {} })];
    fixture.projects = [legacy];
    mount(<ThreadIssuesPanel project={legacy} />);

    expect(fixture.requests).toEqual([]);
    expect(text()).toMatch(/update|upgrade|does not support|doesn.t support|older/i);
  });

  it("issues fence: the thread pane waits for an unknown capability before creating issue queries", () => {
    fixture.environments = [
      environment(supportedEnvironmentId, { phase: "connecting", capabilities: null }),
    ];
    mount(<ThreadIssuesPanel project={alpha} />);

    expect(fixture.requests).toEqual([]);
    expect(text()).toMatch(/connecting|checking|waiting|loading/i);
  });

  it("issues fence: a disconnected supporting environment shows its state and creates no issue queries", async () => {
    fixture.environments = [environment(supportedEnvironmentId, { phase: "reconnecting" })];
    await mountIssuesRoute({ project: keyOf(alpha), issue: 7 });

    expect(fixture.requests).toEqual([]);
    expect(text()).toMatch(/disconnected|offline|reconnecting|not connected|connect/i);
  });

  it("issues guard: the thread pane reads issues once a connected environment advertises support", () => {
    mount(<ThreadIssuesPanel project={alpha} />);

    expect(listRequests().map((request) => request.environmentId)).toEqual([
      supportedEnvironmentId,
    ]);
    expect(text()).toContain("Crash on resume");
  });
});

describe("Issues fence: finished presentation", () => {
  it("issues fence: the page carries no Prototype badge", async () => {
    await mountIssuesRoute({ project: keyOf(alpha) });

    expect(text()).toContain("Issues");
    expect(text()).not.toMatch(/prototype/i);
  });

  it("issues fence: a deleted author with an empty login reads as ghost in the list and the detail", async () => {
    await mountIssuesRoute({ project: keyOf(alpha) });
    const row = container!.querySelector('[data-issue-row][aria-pressed="false"]');
    expect(row?.textContent).toContain("by ghost");

    await click(buttonNamed(/Crash on resume/));
    expect(text()).toContain("ghost opened this issue");
  });

  it("issues fence: the thread pane never reads one project's selected issue number from another project", async () => {
    const other = project(supportedEnvironmentId, "gamma", "gamma");
    fixture.projects = [alpha, other];
    mount(<ThreadIssuesPanel project={alpha} />);
    await click(buttonNamed(/Crash on resume/));
    expect(detailRequests().at(-1)?.input).toEqual({ projectId: alpha.id, number: 7 });

    fixture.requests = [];
    rerender(<ThreadIssuesPanel project={other} />);

    expect(
      detailRequests().filter(
        (request) => (request.input as IssueDetailInput).projectId === other.id,
      ),
    ).toEqual([]);
  });
});

describe("Issues guard: list controls and detail navigation (already true in the prototype)", () => {
  it("issues guard: state filters, search qualifiers, sort and load-more drive the selected project's list read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mountIssuesRoute({ project: keyOf(alpha) });
    const latest = () => listRequests().at(-1)?.input as IssueListInput;
    expect(latest()).toEqual({
      projectId: alpha.id,
      state: "open",
      query: " sort:updated-desc",
      limit: 100,
    });

    await click(buttonNamed(/^Closed$/));
    expect(latest().state).toBe("closed");
    await click(buttonNamed(/^All$/));
    expect(latest().state).toBe("all");

    const sort = container!.querySelector<HTMLSelectElement>('select[aria-label="Sort issues"]')!;
    act(() => {
      sort.value = "created";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settleRouter();
    expect(latest().query).toBe(" sort:created-desc");

    const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search issues"]')!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, "label:bug is:unassigned");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await settleRouter();
    expect(latest().query).toBe("label:bug is:unassigned sort:created-desc");

    await click(buttonNamed(/Load more issues/));
    expect(latest()).toMatchObject({ projectId: alpha.id, state: "all", limit: 200 });
  });

  it("issues guard: an issue opens its description and comments, and Back and Escape return to the list", async () => {
    await mountIssuesRoute({ project: keyOf(alpha) });
    expect(detailRequests()).toEqual([]);

    await click(buttonNamed(/Crash on resume/));
    expect(detailRequests().at(-1)?.input).toEqual({ projectId: alpha.id, number: 7 });
    expect(text()).toContain("Steps to reproduce the resume crash");
    expect(text()).toContain("Same crash after suspend");
    expect(container!.querySelector('section[aria-label="Issue #7 details"]')).not.toBeNull();

    await click(buttonNamed(/^\s*Issues\s*Close\s*$/));
    expect(container!.querySelector('section[aria-label="Issue #7 details"]')).toBeNull();

    await click(buttonNamed(/Crash on resume/));
    const detail = container!.querySelector('section[aria-label="Issue #7 details"]')!;
    act(() => {
      detail.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await settleRouter();
    expect(container!.querySelector('section[aria-label="Issue #7 details"]')).toBeNull();
  });

  it("issues guard: the issue detail offers no thread-draft actions or their note", async () => {
    mount(<ThreadIssuesPanel project={alpha} />);
    await click(buttonNamed(/Crash on resume/));

    expect(text()).toContain("Steps to reproduce the resume crash");
    expect(text()).not.toMatch(/Discuss in thread|Work on issue|draft/i);
  });
});

describe("Issues regression: Escape reaches the view from wherever focus naturally lands", () => {
  const detailSection = () => container!.querySelector('section[aria-label="Issue #7 details"]');

  function pressEscapeAtFocus() {
    const target = document.activeElement ?? document.body;
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("issues regression: a chosen issue's detail takes focus and Escape there returns to its row", async () => {
    await mountIssuesRoute({ project: keyOf(alpha) });
    await click(buttonNamed(/Crash on resume/));
    expect(document.activeElement).toBe(detailSection());

    pressEscapeAtFocus();
    await settleRouter();

    expect(detailSection()).toBeNull();
    expect(document.activeElement?.getAttribute("data-issue-row")).toBe("7");
  });

  it("issues regression: Escape closes a detail that is still loading its description", async () => {
    fixture.detailResult = null;
    fixture.detailPending = true;
    mount(<ThreadIssuesPanel project={alpha} />);
    await click(buttonNamed(/Crash on resume/));
    expect(text()).toContain("Loading description and comments");
    expect(document.activeElement).toBe(detailSection());

    pressEscapeAtFocus();

    expect(detailSection()).toBeNull();
  });

  it("issues regression: Escape from the issue list closes the open detail beside it", async () => {
    await mountIssuesRoute({ project: keyOf(alpha) });
    await click(buttonNamed(/Crash on resume/));
    act(() => {
      container!.querySelector<HTMLElement>('[data-issue-row="8"]')!.focus();
    });

    pressEscapeAtFocus();
    await settleRouter();

    expect(detailSection()).toBeNull();
  });

  it("issues regression: the first Escape stays in the view, so a surrounding sheet stays open", () => {
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    try {
      mount(<ThreadIssuesPanel project={alpha} />);
      act(() => {
        buttonNamed(/Crash on resume/).click();
      });
      const event = pressEscapeAtFocus();

      expect(event.defaultPrevented).toBe(true);
      expect(reachedDocument).not.toHaveBeenCalled();
      expect(detailSection()).toBeNull();
    } finally {
      document.removeEventListener("keydown", reachedDocument);
    }
  });

  it("issues regression: Escape inside an overlay outside the view leaves the open issue alone", () => {
    mount(<ThreadIssuesPanel project={alpha} />);
    act(() => {
      buttonNamed(/Crash on resume/).click();
    });
    const dialog = document.createElement("div");
    dialog.setAttribute("data-slot", "dialog-popup");
    dialog.tabIndex = -1;
    document.body.append(dialog);
    act(() => dialog.focus());

    const event = pressEscapeAtFocus();
    dialog.remove();

    expect(event.defaultPrevented).toBe(false);
    expect(detailSection()).not.toBeNull();
  });
});

describe("Issues rework: project ownership of search, eligibility and catalog readiness", () => {
  function onProvider(candidate: EnvironmentProject, provider: string | null): EnvironmentProject {
    return {
      ...candidate,
      repositoryIdentity:
        provider === null
          ? null
          : {
              ...(candidate.repositoryIdentity as object),
              provider,
              canonicalKey: `${provider}/x`,
            },
    } as unknown as EnvironmentProject;
  }

  function typeSearch(value: string) {
    const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search issues"]')!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return search;
  }

  it("issues rework: search text typed for one project never reaches another project's list", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const beta = project(supportedEnvironmentId, "beta", "beta");
    fixture.projects = [alpha, beta];
    const router = await mountIssuesRoute({ project: keyOf(alpha) });

    typeSearch("label:stale");
    const select = container!.querySelector<HTMLSelectElement>(
      'select[aria-label="Issue project"]',
    )!;
    act(() => {
      select.value = keyOf(beta);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settleRouter();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await settleRouter();

    const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search issues"]')!;
    expect(search.value).toBe("");
    expect((router.state.location.search as { q?: string }).q ?? "").toBe("");
    const betaQueries = listRequests()
      .filter((request) => (request.input as IssueListInput).projectId === beta.id)
      .map((request) => (request.input as IssueListInput).query);
    expect(betaQueries.length).toBeGreaterThan(0);
    expect(betaQueries.every((query) => !query.includes("label:stale"))).toBe(true);
  });

  it("issues rework: the thread pane drops a pending search when it is handed another project", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gamma = project(supportedEnvironmentId, "gamma", "gamma");
    fixture.projects = [alpha, gamma];
    mount(<ThreadIssuesPanel project={alpha} />);
    typeSearch("label:stale");

    rerender(<ThreadIssuesPanel project={gamma} />);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    const gammaQueries = listRequests()
      .filter((request) => (request.input as IssueListInput).projectId === gamma.id)
      .map((request) => (request.input as IssueListInput).query);
    expect(gammaQueries.length).toBeGreaterThan(0);
    expect(gammaQueries.every((query) => !query.includes("label:stale"))).toBe(true);
    expect(
      container!.querySelector<HTMLInputElement>('input[aria-label="Search issues"]')!.value,
    ).toBe("");
  });

  it("issues rework: the default project skips a known non-GitHub repository", async () => {
    const gitlab = onProvider(project(supportedEnvironmentId, "lab", "lab"), "gitlab");
    fixture.projects = [gitlab, alpha];
    await mountIssuesRoute();

    expect(listRequests().map((request) => (request.input as IssueListInput).projectId)).toEqual(
      expect.arrayContaining([alpha.id]),
    );
    expect(
      listRequests().filter((request) => (request.input as IssueListInput).projectId === gitlab.id),
    ).toEqual([]);
  });

  it("issues rework: an explicit non-GitHub project is explained and never read", async () => {
    const gitlab = onProvider(project(supportedEnvironmentId, "lab", "lab"), "gitlab");
    fixture.projects = [alpha, gitlab];
    await mountIssuesRoute({ project: keyOf(gitlab), issue: 7 });

    expect(fixture.requests).toEqual([]);
    expect(text()).toMatch(/GitHub/);
    expect(text()).toMatch(/not available|only|not on GitHub/i);
  });

  it("issues rework: a project whose repository identity is unknown still reads through the server", async () => {
    const unknown = onProvider(project(supportedEnvironmentId, "plain", "plain"), null);
    fixture.projects = [unknown];
    await mountIssuesRoute();

    expect(listRequests().map((request) => (request.input as IssueListInput).projectId)).toEqual([
      unknown.id,
    ]);
  });

  it("issues rework: an unloaded project catalog shows loading, not an empty workspace", async () => {
    fixture.projectsKnown = false;
    fixture.projects = [];
    await mountIssuesRoute();

    expect(text()).not.toMatch(/Add a project/);
    expect(text()).toMatch(/loading|waiting|connecting/i);
    expect(fixture.requests).toEqual([]);
  });

  it("issues rework: a URL project is not called unavailable before the catalog has loaded", async () => {
    fixture.projectsKnown = false;
    fixture.projects = [];
    await mountIssuesRoute({ project: keyOf(alpha) });

    expect(text()).not.toMatch(/not available/i);
    expect(text()).toMatch(/loading|waiting|connecting/i);
    expect(fixture.requests).toEqual([]);
  });
});

describe("Issues phase 3 fence: the thread pane follows each issue selection", () => {
  const detailFor = (number: number) =>
    container!.querySelector(`section[aria-label="Issue #${number} details"]`);

  it("issues phase 3 fence: a pane opened on a selection shows that issue's detail", () => {
    mount(<ThreadIssuesPanel project={alpha} selection={{ number: 7, requestId: 1 }} />);

    expect(detailRequests().at(-1)?.input).toEqual({ projectId: alpha.id, number: 7 });
    expect(detailFor(7)).not.toBeNull();
  });

  it("issues phase 3 fence: a new selection while the pane is open replaces the shown issue", () => {
    mount(<ThreadIssuesPanel project={alpha} selection={{ number: 7, requestId: 1 }} />);
    rerender(<ThreadIssuesPanel project={alpha} selection={{ number: 8, requestId: 2 }} />);

    expect(detailRequests().at(-1)?.input).toEqual({ projectId: alpha.id, number: 8 });
    expect(detailFor(8)).not.toBeNull();
    expect(detailFor(7)).toBeNull();
  });

  it("issues phase 3 fence: Back keeps the list until the same issue is chosen again", async () => {
    mount(<ThreadIssuesPanel project={alpha} selection={{ number: 7, requestId: 1 }} />);
    expect(detailFor(7)).not.toBeNull();
    await click(buttonNamed(/^\s*Issues\s*Close\s*$/));
    expect(detailFor(7)).toBeNull();

    // Re-rendering with the selection already consumed must not undo the reader's Back.
    rerender(<ThreadIssuesPanel project={alpha} selection={{ number: 7, requestId: 1 }} />);
    expect(detailFor(7)).toBeNull();

    rerender(<ThreadIssuesPanel project={alpha} selection={{ number: 7, requestId: 2 }} />);
    expect(detailFor(7)).not.toBeNull();
  });

  it("issues phase 3 fence: filters and search left in the pane never stop a selected issue from loading", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount(<ThreadIssuesPanel project={alpha} />);
    await click(buttonNamed(/^Closed$/));
    const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search issues"]')!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, "label:docs");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    rerender(<ThreadIssuesPanel project={alpha} selection={{ number: 8, requestId: 1 }} />);

    expect(detailRequests().at(-1)?.input).toEqual({ projectId: alpha.id, number: 8 });
    expect(detailFor(8)).not.toBeNull();
  });
});

describe("Issues phase 3 regression: a shown selection is not shown again", () => {
  it("issues phase 3 regression: the pane reports the selection it opened and reopens a consumed one on the list", () => {
    const consumed: number[] = [];
    mount(
      <ThreadIssuesPanel
        project={alpha}
        selection={{ number: 7, requestId: 3 }}
        onSelectionConsumed={(requestId) => consumed.push(requestId)}
      />,
    );
    expect(consumed).toEqual([3]);
    act(() => root?.unmount());
    container?.remove();

    // Closing and reopening the pane after Back remounts it with the consumed choice.
    fixture.requests = [];
    mount(
      <ThreadIssuesPanel project={alpha} selection={{ number: 7, requestId: 3, consumed: true }} />,
    );
    expect(detailRequests()).toEqual([]);
    expect(container!.querySelector('section[aria-label="Issue #7 details"]')).toBeNull();
  });
});
