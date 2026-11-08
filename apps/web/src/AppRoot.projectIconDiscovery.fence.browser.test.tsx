import { flushBrowserTasks } from "./test/browserTasks";
import { act, render as renderBrowser, type Screen } from "../test/render";
// Project icon discovery phase 1 through the real CommandPalette's dialog host, opened with
// `openProjectIconDiscoveryDialog`. `projectIcons.preview` answers from the fixture, and
// `projectIcons.discover` accepts with a job token at once. Pushing a project with a new
// `iconDiscovery` re-renders its readers, as a `project-upserted` shell event does.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AppRouter } from "./router";

import { appRootFence, makeFenceSession } from "./test/appRootFenceMocks";
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original, fixture.environments),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);

interface FixtureProject {
  id: string;
  environmentId: string;
  title: string;
  workspaceRoot: string;
  scripts: [];
  createdAt: string;
  updatedAt: string;
  defaultModelSelection: null;
  faviconPath: string | null;
  projectIcon: null;
  iconDiscovery: {
    generation: number;
    jobToken: string | null;
    status: string;
    path: string | null;
    reason: string;
  } | null;
}

const fixture = vi.hoisted(() => ({
  projects: [] as FixtureProject[],
  projectListeners: new Set<() => void>(),
  previews: [] as unknown[],
  previewRequests: [] as Array<{ environmentId: string; input: unknown }>,
  discoverRequests: [] as Array<{ environmentId: string; input: { projectId: string } }>,
  noopCommand: async () => ({ _tag: "Success", value: { providers: [] } }),
  empty: [],
  environments: [
    {
      environmentId: "icon-fence-environment",
      label: "Fence environment",
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
      connection: { phase: "connected" },
      serverConfig: {
        environment: { capabilities: {}, platform: { machine: "server" } },
        settings: { environmentIcon: null },
        providers: [],
      },
    },
  ],
}));

// Stable functions, as the real hook's `useCallback` returns: a new identity on
// every render would rerun the dialog's preview effect and its cleanup.
const previewCommand = async (value: { environmentId: string; input: unknown }) => {
  fixture.previewRequests.push(value);
  return { _tag: "Success", value: fixture.previews };
};
const discoverCommand = async (value: { environmentId: string; input: { projectId: string } }) => {
  fixture.discoverRequests.push(value);
  return {
    _tag: "Success",
    value: {
      projectId: value.input.projectId,
      jobToken: tokenFor(value.input.projectId),
      // The server claims the next generation for a new job.
      generation:
        (fixture.projects.find((project) => project.id === value.input.projectId)?.iconDiscovery
          ?.generation ?? 0) + 1,
    },
  };
};
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string }) =>
    command.label === "project-icons:preview"
      ? previewCommand
      : command.label === "project-icons:discover"
        ? discoverCommand
        : fixture.noopCommand,
}));
vi.mock("./state/entities", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.projectListeners.add(listener);
    return () => {
      fixture.projectListeners.delete(listener);
    };
  };
  const useFixtureProjects = () => useSyncExternalStore(subscribe, () => fixture.projects);
  const findProject = (ref: { projectId?: string } | null) =>
    ref === null
      ? null
      : (fixture.projects.find((project) => project.id === ref.projectId) ?? null);
  return {
    ...(await importOriginal<typeof import("./state/entities")>()),
    useProjects: useFixtureProjects,
    readProjects: () => fixture.projects,
    useProject: (ref: { projectId?: string } | null) =>
      useSyncExternalStore(subscribe, () => findProject(ref)),
    readProject: findProject,
    useThreadRefs: () => fixture.empty,
    useThreadShells: () => fixture.empty,
  };
});
vi.mock("./state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments, isReady: true }),
  useEnvironment: () => fixture.environments[0],
  useEnvironmentProviders: () => new Map(),
  usePrimaryEnvironment: () => null,
}));
vi.mock("./state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => () => fixture.noopCommand(),
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
vi.mock("./hooks/useHandleNewThread", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hooks/useHandleNewThread")>()),
  useNewThreadHandler: () => fixture.noopCommand,
}));
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

import {
  closeProjectIconDiscoveryDialog,
  openProjectIconDiscoveryDialog,
} from "./components/projects/ProjectIconDiscoveryDialog";

const { Outlet } = await import("@tanstack/react-router");
const { AppRoot } = await import("./AppRoot");
const { CommandPalette } = await import("./components/CommandPalette");

const environmentId = EnvironmentId.make("icon-fence-environment");
const now = "2026-10-11T00:00:00.000Z";
let root: Screen | undefined;
let container: HTMLDivElement;

function tokenFor(projectId: string) {
  return `job-${projectId}`;
}

function makeProject(id: string, title: string): FixtureProject {
  return {
    id,
    environmentId,
    title,
    workspaceRoot: `/tmp/icon-fence/${id}`,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    defaultModelSelection: null,
    faviconPath: null,
    projectIcon: null,
    iconDiscovery: null,
  };
}

function preview(id: string, title: string, status: string, candidateCount = 0) {
  return {
    projectId: ProjectId.make(id),
    title,
    candidateCount,
    status,
    reason: status === "ready" ? `${candidateCount} local image candidates` : status,
  };
}

/** A project upsert carrying a discovery state, as the shell stream delivers one. */
async function pushDiscovery(
  id: string,
  discovery: {
    jobToken: string;
    status: string;
    path?: string | null;
    reason?: string;
    generation?: number;
  },
) {
  fixture.projects = fixture.projects.map((project) =>
    project.id === id
      ? {
          ...project,
          faviconPath:
            discovery.status === "selected" ? (discovery.path ?? null) : project.faviconPath,
          iconDiscovery: {
            // A job keeps its generation through its stages; a new token takes the next one.
            generation:
              discovery.generation ??
              (project.iconDiscovery?.jobToken === discovery.jobToken
                ? project.iconDiscovery.generation
                : (project.iconDiscovery?.generation ?? 0) + 1),
            jobToken: discovery.jobToken,
            status: discovery.status,
            path: discovery.path ?? null,
            reason: discovery.reason ?? discovery.status,
          },
        }
      : project,
  );
  await act(async () => {
    for (const listener of fixture.projectListeners) listener();
  });
  await settle();
}

const submitted = () => fixture.discoverRequests.map((request) => request.input.projectId);

async function setupBrowserFixture0() {
  for (const environment of fixture.environments) {
    appRootFence.sessions.set(environment.environmentId, makeFenceSession());
  }
  localStorage.clear();
  fixture.previewRequests.length = 0;
  fixture.environments[0]!.connection.phase = "connected";
  fixture.discoverRequests.length = 0;
  fixture.projects = [
    makeProject("alpha", "Alpha"),
    makeProject("bravo", "Bravo"),
    makeProject("charlie", "Charlie"),
    makeProject("delta", "Delta"),
  ];
  fixture.previews = [
    preview("alpha", "Alpha", "ready", 3),
    preview("bravo", "Bravo", "existing"),
    preview("charlie", "Charlie", "ready", 2),
    preview("delta", "Delta", "empty"),
  ];
  container = document.createElement("div");
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      // The dialog's target lives in the app-wide atom registry, which outlives a
      // mounted app; close it so the next spec starts with no dialog open.
      closeProjectIconDiscoveryDialog();
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

async function mountApp() {
  const route = createRootRoute({
    component: () => (
      <CommandPalette>
        <Outlet />
      </CommandPalette>
    ),
  });
  const pageRoute = createRoute({
    getParentRoute: () => route,
    path: "/",
    component: () => <div>Page</div>,
  });
  const router = createRouter({
    routeTree: route.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => {
    root = await renderBrowser(null, { container: container, router: false });
    await root.rerender(<AppRoot router={router as unknown as AppRouter} />);
  });
  await settle();
}

async function settle() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

async function openBatch() {
  await mountApp();
  await act(async () => openProjectIconDiscoveryDialog({ environmentId }));
  await settle();
}

function button(label: string | RegExp): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((element) =>
    typeof label === "string"
      ? element.textContent?.trim() === label
      : label.test(element.textContent ?? ""),
  );
  expect(
    found,
    `Expected a "${label}" button; rendered: ${document.body.textContent}`,
  ).toBeTruthy();
  return found!;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await settle();
}

it("icon discovery dialog guard: opening the batch previews one environment and starts nothing", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  expect(fixture.previewRequests).toEqual([{ environmentId, input: {} }]);
  expect(fixture.discoverRequests).toEqual([]);
  expect(button("Find icons for 2 projects").disabled).toBe(false);
});

it("icon discovery dialog fence: the batch submits the next project only after the previous outcome", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  expect(submitted(), "only the first confirmed project runs until its outcome arrives").toEqual([
    "alpha",
  ]);
  expect(fixture.discoverRequests[0]?.environmentId).toBe(environmentId);

  await pushDiscovery("alpha", {
    jobToken: tokenFor("alpha"),
    status: "selected",
    path: "public/alpha-logo.svg",
  });
  expect(submitted()).toEqual(["alpha", "charlie"]);

  await pushDiscovery("charlie", { jobToken: tokenFor("charlie"), status: "none" });
  expect(submitted(), "existing and empty projects are never submitted").toEqual([
    "alpha",
    "charlie",
  ]);
  expect(document.body.textContent).not.toContain("The agent is checking");
  expect(document.body.textContent).toContain("public/alpha-logo.svg");
});

it("icon discovery dialog fence: a project eligible after confirmation is not added", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  fixture.previews = [...fixture.previews, preview("echo", "Echo", "ready", 1)];
  fixture.projects = [...fixture.projects, makeProject("echo", "Echo")];
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "none" });
  await pushDiscovery("charlie", { jobToken: tokenFor("charlie"), status: "none" });
  expect(submitted()).toEqual(["alpha", "charlie"]);
  expect(fixture.previewRequests).toHaveLength(1);
});

it("icon discovery dialog fence: an outcome for another job token does not advance the batch", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  await pushDiscovery("alpha", { jobToken: "job-from-another-command", status: "selected" });
  expect(submitted()).toEqual(["alpha"]);
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "none" });
  expect(submitted()).toEqual(["alpha", "charlie"]);
});

it("icon discovery dialog fence: Stop after this project submits nothing further", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  await click(button("Stop after this project"));
  expect(submitted()).toEqual(["alpha"]);
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "selected" });
  expect(submitted()).toEqual(["alpha"]);
  expect(document.body.textContent).not.toContain("The agent is checking");
  expect(button("Close").disabled).toBe(false);
});

it("icon discovery dialog fence: closing the client leaves later projects unstarted", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  expect(submitted()).toEqual(["alpha"]);
  await act(async () => root?.[Symbol.asyncDispose]());
  root = undefined;
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "selected" });
  // Reconnecting mounts a fresh client; it never resumes the old batch.
  await mountApp();
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "selected" });
  expect(submitted()).toEqual(["alpha"]);
});

it("icon discovery dialog fence: an unavailable outcome is shown and the batch ends", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.previews = [preview("alpha", "Alpha", "ready", 3)];
  await openBatch();
  await click(button("Find icons for 1 project"));
  await pushDiscovery("alpha", {
    jobToken: tokenFor("alpha"),
    status: "unavailable",
    reason: "No enabled Codex instance supports Luna.",
  });
  expect(document.body.textContent).toContain("No enabled Codex instance supports Luna.");
  expect(document.body.textContent).not.toContain("The agent is checking");
  expect(button("Close").disabled).toBe(false);
});

it("icon discovery dialog fence: a dropped connection never submits the remaining projects", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  fixture.environments[0]!.connection.phase = "disconnected";
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "running" });
  fixture.environments[0]!.connection.phase = "connected";
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "none" });
  expect(submitted(), "the reconnect delivers the outcome but resumes nothing").toEqual(["alpha"]);
  expect(document.body.textContent).not.toContain("The agent is checking");
  expect(document.body.textContent).toContain("Projects not yet started will not run.");
});

it("icon discovery dialog fence: a newer job on the project ends the replaced search", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  // The superseded update for the dialog's own token never reached it; the
  // project already carries a newer deliberate search, which it must not claim.
  await pushDiscovery("alpha", {
    jobToken: "newer-deliberate-search",
    status: "selected",
    path: "public/newer.svg",
    // The dialog's job held generation 1; the reset and the newer request came after it.
    generation: 3,
  });
  expect(document.body.textContent).not.toContain("The agent is checking Alpha");
  expect(document.body.textContent).not.toContain("public/newer.svg");
  expect(submitted()).toEqual(["alpha", "charlie"]);
});

it("icon discovery dialog regression: a shown outcome survives later changes to its project", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  await pushDiscovery("alpha", {
    jobToken: tokenFor("alpha"),
    status: "selected",
    path: "public/alpha-logo.svg",
  });
  // A manual reset and a newer search move the project's state on.
  await pushDiscovery("alpha", {
    jobToken: tokenFor("alpha"),
    status: "superseded",
    generation: 2,
  });
  await pushDiscovery("alpha", {
    jobToken: "newer-search-from-another-client",
    status: "none",
    generation: 3,
  });
  expect(document.body.textContent).toContain("Saved: public/alpha-logo.svg");
  expect(submitted()).toEqual(["alpha", "charlie"]);
});

it("icon discovery dialog regression: one outcome advances the batch once", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await openBatch();
  await click(button("Find icons for 2 projects"));
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "none" });
  // A shell refetch delivers the same outcome again while the next project runs.
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "none" });
  await pushDiscovery("alpha", { jobToken: tokenFor("alpha"), status: "none" });
  expect(submitted()).toEqual(["alpha", "charlie"]);
  await pushDiscovery("charlie", { jobToken: tokenFor("charlie"), status: "none" });
  await pushDiscovery("charlie", { jobToken: tokenFor("charlie"), status: "none" });
  expect(submitted()).toEqual(["alpha", "charlie"]);
  expect(button("Close").disabled).toBe(false);
});
