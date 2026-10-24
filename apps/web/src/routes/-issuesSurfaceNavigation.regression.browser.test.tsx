import "../index.css";
import "../mesura.css";

import { act, render as renderBrowser, type Screen } from "../../test/render";
/**
 * Entry point: the real `/_chat/pull-requests` file route (`_chat.pull-requests.tsx`), mounted at
 * `/pull-requests` beside a stand-in `/issues` page, with the shared pull-request panel open in
 * the real right-panel store. The reader opens the real Add surface launcher in the panel's tab
 * strip and chooses Issues.
 *
 * The fixture replaces boundaries only: the environment and project hooks, the pull-request list
 * reads, the live-refresh subscription, and the pull-request detail panel the open tab renders.
 *
 * Issues pane, phase 2, regression: the pull-request page has no thread to hold an Issues pane, so
 * its Add surface entry navigates to the standalone page, and only when a server can read issues.
 */
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";

import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  environments: [] as Array<ReturnType<typeof connectedEnvironment>>,
  projects: [] as Array<typeof project>,
}));

vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: fixture.environments,
    presentationById: new Map(),
  }),
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useProjects: () => fixture.projects,
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("~/state/pullRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/pullRequests")>()),
  usePullRequestList: () => ({ data: null, error: null, isPending: false, refresh: () => {} }),
  usePullRequestListStats: () => ({ stats: null, isPending: false, refresh: () => {} }),
  usePullRequestTurnRefreshes: () => [],
}));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("~/hooks/useOpenPanelPullRequestUrl", () => ({
  useOpenPanelPullRequestUrl: () => null,
}));
vi.mock("~/components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => <div>Pull request detail</div>,
}));

import { closePanelLauncher } from "~/lib/panelLauncher";

import { PULL_REQUESTS_PANEL_REF, useRightPanelStore } from "~/rightPanelStore";

import { Route as PullRequestsRoute } from "./_chat.pull-requests";

import { SidebarProvider } from "~/components/ui/sidebar";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

const environmentId = EnvironmentId.make("issues-navigation-env");

function connectedEnvironment(capabilities: Record<string, unknown>) {
  return {
    environmentId,
    label: "Workstation",
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: {
      settings: { environmentIcon: null },
      environment: {
        platform: { machine: "server" },
        capabilities: { repositoryIdentity: true, pullRequests: true, ...capabilities },
      },
    },
  };
}

const project = {
  id: ProjectId.make("issues-navigation-project"),
  environmentId,
  title: "alpha",
  workspaceRoot: "/work/alpha",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/alpha",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
    provider: "github",
    owner: "acme",
    name: "alpha",
    webUrl: "https://github.com/acme/alpha",
  },
};

async function settleRouter(router: AnyRouter) {
  await act(async () => {
    await router.latestLoadPromise;
  });
  await vi.waitFor(() => expect(router.state.status).toBe("idle"));
}

async function mountPullRequestsPage() {
  await using stack = new AsyncDisposableStack();
  const shell = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const chat = createRoute({ getParentRoute: () => shell, id: "_chat" });
  const pullRequests = (PullRequestsRoute as unknown as ReturnType<typeof createRoute>).update({
    id: "/pull-requests",
    path: "/pull-requests",
    getParentRoute: () => chat,
  } as never);
  const issues = createRoute({
    getParentRoute: () => chat,
    path: "/issues",
    component: () => <p>Standalone issues page</p>,
  });
  const router = createRouter({
    routeTree: shell.addChildren([chat.addChildren([pullRequests as never, issues])]),
    history: createMemoryHistory({ initialEntries: ["/pull-requests"] }),
    disableGlobalCatchBoundary: true,
  });
  await router.load();
  const screen = stack.use(
    await renderBrowser(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
      // This fixture mounts its own file-route tree.
      { router: false },
    ),
  );
  await expect
    .element(screen.getByRole("button", { name: "Add panel surface", exact: true }))
    .toBeInTheDocument();
  const lifetime = stack.move();
  return {
    screen,
    router,
    container: screen.container,
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
  };
}

async function openAddSurfaceMenu(screen: Screen) {
  const trigger = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Add panel surface"]',
  );
  expect(trigger, "the shared pull-request panel shows its tab strip").not.toBeNull();
  await act(async () => {
    trigger!.click();
  });
  await expect.element(screen.getByLabelText("Open a surface")).toBeInTheDocument();
  const menu = screen.container.querySelector<HTMLElement>('[aria-label="Open a surface"]');
  expect(menu?.textContent).toContain("Issues");
  return menu!;
}

function issuesMenuItem(menu: HTMLElement) {
  const item = Array.from(menu.querySelectorAll<HTMLElement>("button")).find((candidate) =>
    candidate.textContent?.trim().startsWith("Issues"),
  );
  expect(item).toBeDefined();
  return item!;
}

function setup() {
  fixture.environments = [];
  fixture.projects = [project];
  closePanelLauncher();
  const previous = useRightPanelStore.getState();
  useRightPanelStore.getState().closeAllSurfaces(PULL_REQUESTS_PANEL_REF);
  useRightPanelStore.getState().openPullRequest(PULL_REQUESTS_PANEL_REF, {
    environmentId,
    projectId: project.id,
    repository: "acme/alpha",
    number: 12,
  });

  return {
    [Symbol.dispose]() {
      closePanelLauncher();
      useRightPanelStore.setState(previous);
    },
  };
}

describe("Issues regression: the pull-request page's Add surface entry", () => {
  it("issues navigation regression: choosing Issues on the pull-request page opens the standalone page", async () => {
    using _fixture = setup();

    fixture.environments = [connectedEnvironment({ issues: true })];
    await using page = await mountPullRequestsPage();
    const menu = await openAddSurfaceMenu(page.screen);

    await act(async () => {
      issuesMenuItem(menu).click();
    });
    await settleRouter(page.router);

    await vi.waitFor(() => expect(page.router.state.location.pathname).toBe("/issues"));
    await expect
      .element(page.screen.getByText("Standalone issues page", { exact: true }))
      .toBeInTheDocument();
  });

  it("issues navigation regression: without a server that reads issues the entry stays on the pull-request page", async () => {
    using _fixture = setup();

    fixture.environments = [connectedEnvironment({})];
    await using page = await mountPullRequestsPage();
    const menu = await openAddSurfaceMenu(page.screen);
    const item = issuesMenuItem(menu);

    expect(item.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      item.click();
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true }),
      );
    });
    await settleRouter(page.router);

    expect(page.router.state.location.pathname).toBe("/pull-requests");
  });
});
