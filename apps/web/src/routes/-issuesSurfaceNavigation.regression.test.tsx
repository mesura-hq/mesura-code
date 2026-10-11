// @vitest-environment happy-dom
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
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  environments: [] as Array<unknown>,
  projects: [] as Array<unknown>,
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
import { SidebarProvider } from "~/components/ui/sidebar";
import { PULL_REQUESTS_PANEL_REF, useRightPanelStore } from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { Route as PullRequestsRoute } from "./_chat.pull-requests";

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

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let router: ReturnType<typeof createRouter> | null = null;

async function settleRouter() {
  for (let round = 0; round < 20; round += 1) {
    await act(async () => {
      await router?.latestLoadPromise;
      await Promise.resolve();
    });
    if (router?.state.status === "idle") return;
  }
}

async function mountPullRequestsPage() {
  const shell = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const pullRequests = (PullRequestsRoute as unknown as ReturnType<typeof createRoute>).update({
    id: "/pull-requests",
    path: "/pull-requests",
    getParentRoute: () => shell,
  } as never);
  const issues = createRoute({
    getParentRoute: () => shell,
    path: "/issues",
    component: () => <p>Standalone issues page</p>,
  });
  router = createRouter({
    routeTree: shell.addChildren([pullRequests as never, issues]),
    history: createMemoryHistory({ initialEntries: ["/pull-requests"] }),
  }) as never;
  await act(async () => {
    await router!.load();
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router as never} />
      </AppAtomRegistryProvider>,
    );
  });
  await settleRouter();
}

async function openAddSurfaceMenu() {
  const trigger = container!.querySelector<HTMLButtonElement>(
    'button[aria-label="Add panel surface"]',
  );
  expect(trigger, "the shared pull-request panel shows its tab strip").not.toBeNull();
  await act(async () => {
    trigger!.click();
  });
  const menu = container!.querySelector<HTMLElement>('[aria-label="Open a surface"]');
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.projects = [project];
  useRightPanelStore.getState().openPullRequest(PULL_REQUESTS_PANEL_REF, {
    environmentId,
    projectId: project.id,
    repository: "acme/alpha",
    number: 12,
  });
});

afterEach(() => {
  act(() => {
    closePanelLauncher();
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  root = null;
  container = null;
  router = null;
  useRightPanelStore.getState().closeAllSurfaces?.(PULL_REQUESTS_PANEL_REF);
  vi.unstubAllGlobals();
});

describe("Issues regression: the pull-request page's Add surface entry", () => {
  it("issues navigation regression: choosing Issues on the pull-request page opens the standalone page", async () => {
    fixture.environments = [connectedEnvironment({ issues: true })];
    await mountPullRequestsPage();
    const menu = await openAddSurfaceMenu();

    await act(async () => {
      issuesMenuItem(menu).click();
    });
    await settleRouter();

    expect(router!.state.location.pathname).toBe("/issues");
    expect(container!.textContent).toContain("Standalone issues page");
  });

  it("issues navigation regression: without a server that reads issues the entry stays on the pull-request page", async () => {
    fixture.environments = [connectedEnvironment({})];
    await mountPullRequestsPage();
    const menu = await openAddSurfaceMenu();
    const item = issuesMenuItem(menu);

    expect(item.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      item.click();
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true }),
      );
    });
    await settleRouter();

    expect(router!.state.location.pathname).toBe("/pull-requests");
  });
});
