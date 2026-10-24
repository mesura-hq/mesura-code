import { flushBrowserTasks } from "./test/browserTasks";
import { act, render as renderBrowser, type Screen } from "../test/render";
/**
 * Entry point: AppRoot, whose root route wraps the real `CommandPalette` inside
 * the toast providers around the page, as `routes/__root.tsx` does. The palette
 * mounts the global `ProjectIconFileDialogHost`. The palette specs open the
 * palette through `openCommandPalette` and choose "Update project icon…"; the
 * Settings specs render the real `/settings/projects` page component
 * (`ProjectsSettings`) inside the real `SettingsScopeProvider`, as
 * `routes/settings.tsx` does.
 *
 * Project icons phase 2, acceptance criteria 1 (the palette opens the existing
 * picker; cancel changes nothing), 2 (palette and Settings edits keep the group
 * fan-out and its partial-failure report, each member naming the root it
 * belongs to), 6 (manual selection needs no Luna) and 7 (the result explains a
 * repository icon that masks the saved image).
 *
 * Boundaries the fixture replaces, and nothing else:
 * - The server's commands, at `useAtomCommand`: the project update records each
 *   member's request and answers success or a failure, and
 *   `projectIcons.preview` answers the effective icon from the fixture.
 * - The picker's image search, at `useProjectFilePickerQuery`.
 * - The project store, environments, settings and unrelated chrome, as
 *   `AppRoot.projectIconDiscovery.fence.test.tsx` does.
 */

import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import type { AppRouter } from "./router";

import { appRootFence, makeFenceSession } from "./test/appRootFenceMocks";
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);

interface FixtureProject {
  id: string;
  environmentId: string;
  title: string;
  workspaceRoot: string;
  repositoryIdentity: {
    canonicalKey: string;
    locator: { source: "git-remote"; remoteName: string; remoteUrl: string };
    displayName: string;
  };
  scripts: [];
  createdAt: string;
  updatedAt: string;
  defaultModelSelection: null;
  faviconPath: string | null;
  projectIcon: null;
  iconDiscovery: null;
}

const fixture = vi.hoisted(() => ({
  projects: [] as FixtureProject[],
  projectListeners: new Set<() => void>(),
  updateRequests: [] as Array<{ environmentId: string; input: Record<string, unknown> }>,
  failingEnvironmentId: null as string | null,
  previewRequests: [] as Array<{ environmentId: string; input: unknown }>,
  previews: [] as unknown[],
  discoverRequests: [] as unknown[],
  imageEntries: [
    { path: "public/logo.svg", kind: "file" },
    { path: "public/mark.png", kind: "file" },
  ],
  noopCommand: async () => ({ _tag: "Success", value: { providers: [] } }),
  empty: [],
  environments: [
    {
      environmentId: "icon-laptop",
      label: "Laptop",
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
      connection: { phase: "connected" },
      serverConfig: {
        environment: { capabilities: {}, platform: { machine: "server" } },
        settings: { environmentIcon: null },
        providers: [],
      },
    },
    {
      environmentId: "icon-server",
      label: "Server",
      entry: { target: { _tag: "SavedConnectionTarget" } },
      connection: { phase: "connected" },
      serverConfig: {
        environment: { capabilities: {}, platform: { machine: "server" } },
        settings: { environmentIcon: null },
        providers: [],
      },
    },
  ],
}));

// Stable functions, as the real hook's `useCallback` returns.
const updateCommand = async (value: { environmentId: string; input: Record<string, unknown> }) => {
  fixture.updateRequests.push(value);
  if (value.environmentId === fixture.failingEnvironmentId) {
    const { Cause } = await import("effect");
    return { _tag: "Failure", cause: Cause.fail(new Error("The server refused the update.")) };
  }
  return { _tag: "Success", value: undefined };
};
const previewCommand = async (value: { environmentId: string; input: unknown }) => {
  fixture.previewRequests.push(value);
  return { _tag: "Success", value: fixture.previews };
};
const discoverCommand = async (value: unknown) => {
  fixture.discoverRequests.push(value);
  return { _tag: "Success", value: {} };
};
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string }) =>
    command.label === "environment-data:commands:project:update"
      ? updateCommand
      : command.label === "project-icons:preview"
        ? previewCommand
        : command.label === "project-icons:discover"
          ? discoverCommand
          : fixture.noopCommand,
}));
vi.mock("./components/files/projectFilesQueryState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components/files/projectFilesQueryState")>()),
  useProjectFilePickerQuery: () => ({
    entries: fixture.imageEntries,
    error: null,
    isPending: false,
    matchedQuery: "",
  }),
}));
vi.mock("./state/entities", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.projectListeners.add(listener);
    return () => {
      fixture.projectListeners.delete(listener);
    };
  };
  const findProject = (ref: { projectId?: string } | null) =>
    ref === null
      ? null
      : (fixture.projects.find((project) => project.id === ref.projectId) ?? null);
  return {
    ...(await importOriginal<typeof import("./state/entities")>()),
    // Readers re-render on a project update, as a `project-upserted` shell event does.
    useProjects: () => useSyncExternalStore(subscribe, () => fixture.projects),
    readProjects: () => fixture.projects,
    useProject: findProject,
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
  usePrimaryEnvironmentId: () => "icon-laptop",
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


import { openCommandPalette } from "./commandPaletteBus";





const { Outlet } = await import("@tanstack/react-router");
const { AppRoot } = await import("./AppRoot");
const { CommandPalette } = await import("./components/CommandPalette");
const { ProjectsSettings } = await import("./components/settings/ProjectsSettings");
const { SettingsScopeProvider } = await import("./components/settings/SettingsScopeContext");
const { AnchoredToastProvider, ToastProvider } = await import("./components/ui/toast");

const now = "2026-10-11T00:00:00.000Z";
const CANONICAL_KEY = "github.com/acme/brand";
let root: Screen | undefined;
let container: HTMLDivElement;

function makeProject(id: string, environmentId: string, workspaceRoot: string): FixtureProject {
  return {
    id,
    environmentId,
    title: "Brand",
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey: CANONICAL_KEY,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/brand.git",
      },
      displayName: "acme/brand",
    },
    scripts: [],
    createdAt: now,
    updatedAt: now,
    defaultModelSelection: null,
    faviconPath: null,
    projectIcon: null,
    iconDiscovery: null,
  };
}

/** The effective icon the server reports for one project after a write. */
function effectivePreview(projectId: string, effectiveSource: string) {
  return {
    projectId,
    title: "Brand",
    candidateCount: 0,
    status: "existing",
    reason: "An icon is already shown.",
    effectiveSource,
  };
}

async function setupBrowserFixture0() {



  for (const environment of fixture.environments) {
    appRootFence.sessions.set(environment.environmentId, makeFenceSession());
  }
  localStorage.clear();
  fixture.updateRequests.length = 0;
  fixture.previewRequests.length = 0;
  fixture.discoverRequests.length = 0;
  fixture.failingEnvironmentId = null;
  for (const environment of fixture.environments) {
    environment.connection.phase = "connected";
    // The Settings scope resolves each member's project settings from its server.
    environment.serverConfig.settings = { ...DEFAULT_SERVER_SETTINGS, environmentIcon: null };
  }
  fixture.projects = [
    makeProject("brand-laptop", "icon-laptop", "/home/dev/brand"),
    makeProject("brand-server", "icon-server", "/srv/checkouts/brand"),
  ];
  fixture.previews = [
    effectivePreview("brand-laptop", "project"),
    effectivePreview("brand-server", "project"),
  ];
  container = document.createElement("div");
  document.body.append(container);

return {async [Symbol.asyncDispose]() {

  await act(async () => root?.[Symbol.asyncDispose]());
  root = undefined;
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();

}};
}



async function mountApp(page: "home" | "settings" = "home") {
  const route = createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <CommandPalette>
            <Outlet />
          </CommandPalette>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  });
  const homeRoute = createRoute({
    getParentRoute: () => route,
    path: "/",
    component: () => <div>Page</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => route,
    path: "/settings/projects",
    component: () => (
      <SettingsScopeProvider search={{ project: CANONICAL_KEY }} onChange={() => undefined}>
        <ProjectsSettings />
      </SettingsScopeProvider>
    ),
  });
  const router = createRouter({
    routeTree: route.addChildren([homeRoute, settingsRoute]),
    history: createMemoryHistory({
      initialEntries: [page === "settings" ? "/settings/projects" : "/"],
    }),
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

function option(label: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent?.includes(label),
  );
  expect(
    found,
    `Expected a "${label}" option; rendered: ${document.body.textContent}`,
  ).toBeTruthy();
  return found!;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
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

const picker = () => document.body.querySelector('[aria-label="Choose project icon"]');

/** Palette → Update project icon… → the Brand group, as a user reaches the picker. */
async function openPickerFromPalette() {
  await mountApp();
  await act(async () => openCommandPalette({ query: ">update project icon" }));
  await settle();
  await click(option("Update project icon…"));
  await click(option("Brand"));
  expect(picker(), `the picker opens; rendered: ${document.body.textContent}`).not.toBeNull();
}

async function openPickerFromSettings() {
  await mountApp("settings");
  await click(button("Choose a project icon file"));
  expect(picker(), `the picker opens; rendered: ${document.body.textContent}`).not.toBeNull();
}

async function pressEscape() {
  const target = document.activeElement ?? document.body;
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

it("icon manual guard: Update project icon opens the picker and cancel changes nothing", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  await openPickerFromPalette();
  expect(document.body.textContent).toContain("logo.svg");
  await pressEscape();
  expect(picker()).toBeNull();
  expect(fixture.updateRequests).toEqual([]);
  expect(fixture.discoverRequests, "a manual edit never starts a Luna search").toEqual([]);
});

it("icon manual fence: the palette writes every group member with its own root", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  await openPickerFromPalette();
  await click(option("logo.svg"));
  expect(fixture.updateRequests).toEqual([
    {
      environmentId: "icon-laptop",
      input: {
        projectId: "brand-laptop",
        faviconPath: "public/logo.svg",
        projectIcon: null,
        expectedWorkspaceRoot: "/home/dev/brand",
      },
    },
    {
      environmentId: "icon-server",
      input: {
        projectId: "brand-server",
        faviconPath: "public/logo.svg",
        projectIcon: null,
        expectedWorkspaceRoot: "/srv/checkouts/brand",
      },
    },
  ]);
  expect(fixture.discoverRequests).toEqual([]);
});

it("icon manual fence: Settings writes every group member with its own root", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  await openPickerFromSettings();
  await click(option("logo.svg"));
  expect(fixture.updateRequests.map((request) => request.input)).toEqual([
    expect.objectContaining({
      projectId: "brand-laptop",
      faviconPath: "public/logo.svg",
      expectedWorkspaceRoot: "/home/dev/brand",
    }),
    expect.objectContaining({
      projectId: "brand-server",
      faviconPath: "public/logo.svg",
      expectedWorkspaceRoot: "/srv/checkouts/brand",
    }),
  ]);
});

it("icon manual guard: a failed member names its environment and stops the palette fan-out", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.failingEnvironmentId = "icon-laptop";
  await openPickerFromPalette();
  await click(option("logo.svg"));
  expect(fixture.updateRequests.map((request) => request.environmentId)).toEqual(["icon-laptop"]);
  expect(document.body.textContent).toContain("Failed to update project icon on Laptop");
  expect(document.body.textContent).not.toContain("Project icon saved");
});

it("icon manual guard: a disconnected member blocks the Settings write before any update", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.environments[1]!.connection.phase = "disconnected";
  await openPickerFromSettings();
  await click(option("logo.svg"));
  expect(fixture.updateRequests).toEqual([]);
  expect(document.body.textContent).toContain("Connect Server and try again.");
});

it("icon manual fence: the palette says a repository icon still displays after a save", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.previews = [
    effectivePreview("brand-laptop", "mesura"),
    effectivePreview("brand-server", "mesura"),
  ];
  await openPickerFromPalette();
  await click(option("logo.svg"));
  expect(fixture.updateRequests).toHaveLength(2);
  const text = document.body.textContent ?? "";
  expect(text).toMatch(/saved/i);
  expect(text).toContain(".mesura.json");
  expect(fixture.discoverRequests).toEqual([]);
});

it("icon manual fence: Settings says a repository icon still displays after a save", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.previews = [
    effectivePreview("brand-laptop", "mesura"),
    effectivePreview("brand-server", "mesura"),
  ];
  await openPickerFromSettings();
  await click(option("logo.svg"));
  const text = document.body.textContent ?? "";
  expect(text).toMatch(/saved/i);
  expect(text).toContain(".mesura.json");
});

it("icon manual fence: a save that displays says only that it was saved", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  await openPickerFromPalette();
  await click(option("logo.svg"));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Project icon saved");
  expect(text).not.toContain(".mesura.json");
});

/** A project upsert moving one checkout, delivered while a picker is open. */
async function moveCheckout(projectId: string, workspaceRoot: string) {
  fixture.projects = fixture.projects.map((project) =>
    project.id === projectId ? { ...project, workspaceRoot } : project,
  );
  await act(async () => {
    for (const listener of fixture.projectListeners) listener();
  });
  await settle();
}

const expectedRoots = () =>
  fixture.updateRequests.map((request) => [
    request.input.projectId,
    request.input.expectedWorkspaceRoot,
  ]);

it("icon manual rework: the palette writes the roots captured when its picker opened", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  await openPickerFromPalette();
  await moveCheckout("brand-server", "/srv/moved/brand");
  await click(option("logo.svg"));
  expect(expectedRoots()).toEqual([
    ["brand-laptop", "/home/dev/brand"],
    ["brand-server", "/srv/checkouts/brand"],
  ]);
});

it("icon manual rework: Settings writes the roots captured when its picker opened", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  await openPickerFromSettings();
  await moveCheckout("brand-server", "/srv/moved/brand");
  await click(option("logo.svg"));
  expect(expectedRoots()).toEqual([
    ["brand-laptop", "/home/dev/brand"],
    ["brand-server", "/srv/checkouts/brand"],
  ]);
});

it("icon manual rework: a Settings reset names each member's root", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.projects = fixture.projects.map((project) => ({
    ...project,
    faviconPath: "public/logo.svg",
  }));
  await mountApp("settings");
  await click(button("Reset project icon to default"));
  expect(fixture.updateRequests.map((request) => request.input)).toEqual([
    expect.objectContaining({
      faviconPath: null,
      projectIcon: null,
      expectedWorkspaceRoot: "/home/dev/brand",
    }),
    expect.objectContaining({
      faviconPath: null,
      projectIcon: null,
      expectedWorkspaceRoot: "/srv/checkouts/brand",
    }),
  ]);
  expect(fixture.discoverRequests).toEqual([]);
});

it("icon manual rework: checkouts that display different icons are each named", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.previews = [
    effectivePreview("brand-laptop", "project"),
    effectivePreview("brand-server", "mesura"),
  ];
  await openPickerFromPalette();
  await click(option("logo.svg"));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Laptop: Project icon saved.");
  expect(text).toContain("Server: Project icon saved, but the repository icon set in .mesura.json");
});

it("icon manual regression: a checkout missing the saved image is named in the confirmation", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.previews = [
    effectivePreview("brand-laptop", "project"),
    effectivePreview("brand-server", "initials"),
  ];
  await openPickerFromPalette();
  await click(option("logo.svg"));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Laptop: Project icon saved.");
  expect(text).toContain(
    "Server: Project icon saved, but the image was not found in this checkout",
  );
});

it("icon manual regression: every checkout missing the saved image gives one explanation", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.previews = [
    effectivePreview("brand-laptop", "detected"),
    effectivePreview("brand-server", "detected"),
  ];
  await openPickerFromSettings();
  await click(option("logo.svg"));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Project icon saved, but the image was not found in this checkout");
  expect(text).not.toContain("Laptop:");
});

it("icon manual regression: a reset confirms the fallback and starts no search", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

  fixture.projects = fixture.projects.map((project) => ({
    ...project,
    faviconPath: "public/logo.svg",
  }));
  fixture.previews = [
    effectivePreview("brand-laptop", "mesura"),
    effectivePreview("brand-server", "mesura"),
  ];
  await mountApp("settings");
  await click(button("Reset project icon to default"));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Saved project icon cleared");
  expect(text).toContain("No agent search was started.");
  expect(fixture.discoverRequests).toEqual([]);
});
