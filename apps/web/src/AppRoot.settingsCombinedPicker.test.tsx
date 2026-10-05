// @vitest-environment happy-dom
/**
 * Entry point: AppRoot with a memory router whose `/settings/general` and
 * `/settings/source-control` routes render the real GeneralSettingsPanel and
 * SourceControlSettingsPanel inside the real SettingsScopeProvider, with the
 * scope taken from the route search exactly as `routes/settings.tsx` does.
 * The real settings rows, scoped hooks, ProviderModelPicker, and
 * ModelPickerContent run unchanged. Environment presentations, projects, and
 * the `serverEnvironment.updateSettings` command are the fixture below; the
 * command records each patch and applies it to the fixture's server settings,
 * so a reopened picker reads what was saved. The virtual list is a test
 * boundary because happy-dom has no layout.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Outlet,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import type { AppRouter } from "./router";
import {
  pickerContent,
  searchInput,
  rows,
  row,
  highlightedRow,
  effortValue,
  buttonByLabel,
  moreOptionsToggle,
  extrasRegion,
  accessSummary,
  press,
  click,
  openMoreOptions,
} from "./test/combinedPickerDom";

const fixture = vi.hoisted(() => {
  const codexModels = [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
            currentValue: "medium",
          },
          {
            id: "serviceTier",
            label: "Service tier",
            type: "select",
            options: [
              { id: "default", label: "Standard", isDefault: true },
              { id: "priority", label: "Fast" },
            ],
          },
          // Advertised by the chat runtime, not read by Codex text generation.
          {
            id: "contextWindow",
            label: "Context window",
            type: "select",
            options: [
              { id: "272k", label: "272k", isDefault: true },
              { id: "1m", label: "1M" },
            ],
          },
        ],
      },
    },
    {
      slug: "gpt-5.5",
      name: "GPT-5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
            ],
            currentValue: "high",
          },
        ],
      },
    },
  ];
  const claudeModels = [
    {
      slug: "claude-opus-5",
      name: "Claude Opus 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            promptInjectedValues: ["ultrathink"],
          },
          { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
        ],
      },
    },
  ];
  const provider = (instanceId: string, driver: string, models: unknown[]) => ({
    instanceId,
    driver,
    displayName: driver === "codex" ? "Codex" : "Claude",
    enabled: true,
    installed: true,
    workspaceSnapshots: [],
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T12:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  });
  return {
    codexModels,
    claudeModels,
    provider,
    environments: [] as unknown[],
    projects: [] as unknown[],
    listeners: new Set<() => void>(),
    writes: [] as Array<{ environmentId: string; patch: Record<string, unknown> }>,
    commands: new Map<unknown, unknown>(),
    noopCommand: vi.fn(async () => ({ _tag: "Success", value: undefined })),
    toasts: [] as Array<{ type?: string; title?: string; description?: string }>,
    favorites: [] as Array<{ provider: string; model: string }>,
    refresh: vi.fn(),
  };
});

vi.mock("./state/environments", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.listeners.add(listener);
    return () => {
      fixture.listeners.delete(listener);
    };
  };
  const useFixtureEnvironments = () =>
    useSyncExternalStore(subscribe, () => fixture.environments) as never;
  return {
    ...(await importOriginal<typeof import("./state/environments")>()),
    useEnvironments: () => ({ environments: useFixtureEnvironments(), isReady: true }),
    usePrimaryEnvironmentId: () => "laptop",
    usePrimaryEnvironment: () => null,
  };
});
vi.mock("./state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/entities")>()),
  useProjects: () => fixture.projects,
}));
vi.mock("./state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: fixture.refresh,
  }),
}));
// composer.effort has no default binding in this fork. Bind it here so the
// alias reaches the Settings picker through the real keybinding resolution.
vi.mock("./state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/server")>();
  const { Atom } = await import("effect/unstable/reactivity");
  const { compileResolvedKeybindingsConfig, mergeWithDefaultKeybindings } =
    await import("@t3tools/shared/keybindings");
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make(
      mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([
          { key: "alt+shift+y", command: "composer.effort", when: "!terminalFocus" },
        ]),
      ),
    ),
  };
});
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => fixture.commands.get(command) ?? fixture.noopCommand,
}));
vi.mock("./state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => fixture.noopCommand }));
vi.mock("./hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  // One stable settings object per favorites list, so identity changes only with it.
  const settingsByFavorites = new Map<unknown, typeof DEFAULT_CLIENT_SETTINGS>();
  const clientSettings = () => {
    if (fixture.favorites.length === 0) return DEFAULT_CLIENT_SETTINGS;
    if (!settingsByFavorites.has(fixture.favorites)) {
      settingsByFavorites.set(fixture.favorites, {
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: fixture.favorites as unknown as typeof DEFAULT_CLIENT_SETTINGS.favorites,
      });
    }
    return settingsByFavorites.get(fixture.favorites)!;
  };
  return {
    ...(await importOriginal<typeof import("./hooks/useSettings")>()),
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(clientSettings()) : clientSettings(),
    useClientSettingsHydrated: () => true,
    persistClientSettingsPatch: vi.fn(),
  };
});
vi.mock("./components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/ui/toast")>();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: (toast: { type?: string; title?: string; description?: string }) => {
        fixture.toasts.push(toast);
        return "toast";
      },
    },
  };
});
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
// happy-dom has no layout. Keep every list's rows real and render them all.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: ReadonlyArray<unknown>;
    renderItem: (input: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <div key={typeof item === "string" ? item : (item as { id: string }).id}>
          {renderItem({ item, index })}
        </div>
      ))}
      {ListFooterComponent}
    </div>
  ),
}));

import { AppRoot } from "./AppRoot";
import { GeneralSettingsPanel } from "./components/settings/SettingsPanels";
import { SourceControlSettingsPanel } from "./components/settings/SourceControlSettings";
import { SettingsScopeProvider } from "./components/settings/SettingsScopeContext";
import { validateSettingsScopeSearch } from "./components/settings/settingsScope";
import { SidebarProvider } from "./components/ui/sidebar";
import { serverEnvironment } from "./state/server";
import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { selectProjectGroupingSettings } from "./logicalProject";

const LAPTOP = EnvironmentId.make("laptop");
const SERVER = EnvironmentId.make("server");
const PROJECT = ProjectId.make("combined-settings-project");
const now = "2026-10-05T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;

type SettingsOverrides = Partial<ServerSettings>;

function environment(
  environmentId: EnvironmentId,
  label: string,
  settings: SettingsOverrides,
  providers: unknown[] = [
    fixture.provider("codex", "codex", fixture.codexModels),
    fixture.provider("claudeAgent", "claudeAgent", fixture.claudeModels),
  ],
) {
  return {
    environmentId,
    label,
    displayUrl: null,
    relayManaged: false,
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        platform: { machine: "server" },
        capabilities: { projectSettingsOverrides: true },
      },
      providers,
      settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
    },
  };
}

function setEnvironments(next: unknown[]) {
  fixture.environments = next;
  for (const listener of fixture.listeners) listener();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fixture server: records the patch and applies it like the settings service. */
async function recordSettingsWrite(input: {
  environmentId: string;
  input: { patch: Record<string, unknown> };
}) {
  fixture.writes.push({ environmentId: input.environmentId, patch: input.input.patch });
  setEnvironments(
    fixture.environments.map((entry) => {
      const presentation = entry as ReturnType<typeof environment>;
      if (presentation.environmentId !== input.environmentId) return entry;
      const settings: Record<string, unknown> = { ...presentation.serverConfig.settings };
      for (const [key, value] of Object.entries(input.input.patch)) {
        const base = settings[key];
        settings[key] = isPlainObject(value) && isPlainObject(base) ? { ...base, ...value } : value;
      }
      return {
        ...presentation,
        serverConfig: { ...presentation.serverConfig, settings: settings as ServerSettings },
      };
    }),
  );
  return { _tag: "Success" as const, value: undefined };
}

function project(environmentId: EnvironmentId) {
  return {
    id: PROJECT,
    environmentId,
    title: "Combined settings",
    workspaceRoot: "/tmp/combined-settings",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  };
}

function projectKey() {
  const groups = buildSidebarProjectSnapshots({
    projects: fixture.projects as never,
    settings: selectProjectGroupingSettings(DEFAULT_CLIENT_SETTINGS),
    primaryEnvironmentId: LAPTOP,
    resolveEnvironmentLabel: () => null,
  });
  expect(groups.length, "Expected one settings project group").toBe(1);
  return groups[0]!.projectKey;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.writes = [];
  fixture.toasts = [];
  fixture.favorites = [];
  fixture.projects = [];
  fixture.commands = new Map([[serverEnvironment.updateSettings, recordSettingsWrite]]);
  setEnvironments([environment(LAPTOP, "Laptop", {})]);
  // happy-dom has no FontFaceSet.
  if (!("fonts" in document)) {
    Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
  }
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type SettingsPage = "general" | "source-control";

async function mountSettings(page: SettingsPage, search: Record<string, string> = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    validateSearch: validateSettingsScopeSearch,
    component: function SettingsLayout() {
      const routeSearch = settingsRoute.useSearch();
      const navigate = settingsRoute.useNavigate();
      return (
        <SettingsScopeProvider
          search={routeSearch}
          onChange={(next) => void navigate({ search: () => next })}
        >
          <Outlet />
        </SettingsScopeProvider>
      );
    },
  });
  const generalRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "/general",
    component: GeneralSettingsPanel,
  });
  const sourceControlRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "/source-control",
    component: SourceControlSettingsPanel,
  });
  const providersRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "/providers",
    component: () => <p data-settings-providers-route>Providers</p>,
  });
  const query = new URLSearchParams(search).toString();
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      settingsRoute.addChildren([generalRoute, sourceControlRoute, providersRoute]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/settings/${page}${query ? `?${query}` : ""}`],
    }),
  });
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
}

const GPT_54: ModelSelection = { instanceId: "codex" as never, model: "gpt-5.4" };
const CLAUDE_OPUS: ModelSelection = { instanceId: "claudeAgent" as never, model: "claude-opus-5" };

function settingsRow(id: string) {
  const element = container.querySelector<HTMLElement>(`[data-slot="settings-row"]#${id}`);
  expect(element, `Expected the ${id} settings row`).toBeTruthy();
  return element!;
}

function rowTrigger(id: string) {
  const trigger = [
    ...settingsRow(id).querySelectorAll<HTMLButtonElement>(
      '[data-chat-provider-model-picker="true"]',
    ),
  ].find((entry) => !entry.closest("[inert]"));
  expect(trigger, `Expected the shared picker trigger in ${id}`).toBeTruthy();
  return trigger!;
}

async function openRowPicker(id: string) {
  await click(rowTrigger(id));
  expect(pickerContent(), `Expected the ${id} picker to open`).toBeTruthy();
}

async function highlight(name: string) {
  for (let attempt = 0; attempt < rows().length + 1; attempt += 1) {
    if (highlightedRow()?.textContent?.includes(name)) return;
    await press(searchInput(), "ArrowDown");
  }
  expect(highlightedRow()?.textContent, `Expected ${name} to be highlighted`).toContain(name);
}

function control(label: string) {
  return pickerContent()?.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? null;
}

/** Chooses a value in a labelled native select inside the picker. */
async function chooseOption(controlLabel: string, optionLabel: string) {
  const element = control(controlLabel);
  expect(
    element,
    `Expected control ${controlLabel}; rendered: ${pickerContent()?.textContent}`,
  ).toBeTruthy();
  expect(element, `Expected ${controlLabel} to be a select`).toBeInstanceOf(HTMLSelectElement);
  const select = element as HTMLSelectElement;
  const option = [...select.options].find((entry) => entry.textContent?.trim() === optionLabel);
  expect(option, `Expected option ${optionLabel} in ${controlLabel}`).toBeTruthy();
  await act(async () => {
    select.value = option!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function pressOutside() {
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      container.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, button: 0 }));
    }
  });
}

function effortButton(direction: "Increase" | "Decrease", name: string) {
  const button = buttonByLabel(`${direction} effort for ${name}`, pickerContent() ?? document);
  expect(button, `Expected the ${direction} effort control for ${name}`).toBeTruthy();
  return button!;
}

function useButton() {
  const button = buttonByLabel(/^Use /, pickerContent() ?? document);
  expect(button, "Expected the Use model button in More options").toBeTruthy();
  return button!;
}

function serverSettings(environmentId: EnvironmentId): ServerSettings {
  const entry = (fixture.environments as Array<ReturnType<typeof environment>>).find(
    (candidate) => candidate.environmentId === environmentId,
  );
  return entry!.serverConfig.settings;
}

function twoEnvironments(
  laptop: SettingsOverrides,
  server: SettingsOverrides,
  serverProviders?: unknown[],
) {
  setEnvironments([
    environment(LAPTOP, "Laptop", laptop),
    environment(SERVER, "Server", server, serverProviders),
  ]);
}

function projectOverride(environmentId: EnvironmentId) {
  return serverSettings(environmentId).projectSettingsOverrides[PROJECT] ?? {};
}

async function mountProjectScope(laptop: SettingsOverrides) {
  setEnvironments([environment(LAPTOP, "Laptop", laptop)]);
  fixture.projects = [project(LAPTOP)];
  await mountSettings("general", { project: projectKey() });
}

describe("settings combined picker new-thread defaults", () => {
  it("settings combined picker: options edits the focused model instead of the saved default", async () => {
    await mountSettings("general");
    await openRowPicker("default-model");
    const favorite = buttonByLabel("Add to favorites", row("GPT-5.5"));
    expect(favorite).toBeTruthy();
    await act(async () => favorite!.focus());
    await openMoreOptions();
    expect(extrasRegion()?.textContent).toContain("GPT-5.5");
    expect(fixture.writes).toEqual([]);
    await click(useButton());
    expect(serverSettings(LAPTOP).defaultModelSelection?.model).toBe("gpt-5.5");
  });

  it("settings combined picker: environment default model saves effort and options from one picker", async () => {
    await mountSettings("general");
    await openRowPicker("default-model");
    expect(effortValue("GPT-5.4")).toBe("Medium");

    await click(effortButton("Increase", "GPT-5.4"));
    expect(effortValue("GPT-5.4")).toBe("High");
    await highlight("GPT-5.4");
    await openMoreOptions();
    await chooseOption("Service tier", "Fast");
    expect(fixture.writes).toEqual([]);
    await click(row("GPT-5.4"));

    expect(pickerContent()).toBeNull();
    expect(fixture.writes).toHaveLength(1);
    expect(Object.keys(fixture.writes[0]!.patch)).toEqual(["defaultModelSelection"]);
    expect(serverSettings(LAPTOP).defaultModelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.4",
      options: expect.arrayContaining([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ]),
    });

    await openRowPicker("default-model");
    expect(effortValue("GPT-5.4")).toBe("High");
  });

  it("settings combined picker: project default model writes options into the project override only", async () => {
    await mountProjectScope({ defaultRuntimeMode: "approval-required" });
    await openRowPicker("default-model");
    await click(effortButton("Decrease", "GPT-5.5"));
    expect(effortValue("GPT-5.5")).toBe("Medium");
    await click(row("GPT-5.5"));

    expect(fixture.writes).toHaveLength(1);
    expect(projectOverride(LAPTOP)).toEqual({
      defaultModelSelection: {
        instanceId: "codex",
        model: "gpt-5.5",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    });
    expect(serverSettings(LAPTOP).defaultRuntimeMode).toBe("approval-required");
  });

  it("settings combined picker: choosing a default model keeps each environment's own access", async () => {
    twoEnvironments(
      { defaultModelSelection: GPT_54, defaultRuntimeMode: "full-access" },
      { defaultModelSelection: GPT_54, defaultRuntimeMode: "approval-required" },
    );
    await mountSettings("general");
    await openRowPicker("default-model");
    expect(accessSummary()).toContain("Mixed");
    await click(row("GPT-5.5"));

    expect(fixture.writes.map((write) => Object.keys(write.patch))).toEqual([
      ["defaultModelSelection"],
      ["defaultModelSelection"],
    ]);
    expect(serverSettings(LAPTOP).defaultRuntimeMode).toBe("full-access");
    expect(serverSettings(SERVER).defaultRuntimeMode).toBe("approval-required");
    expect(serverSettings(SERVER).defaultModelSelection?.model).toBe("gpt-5.5");
  });

  it("settings combined picker: an access-only edit from Permissions leaves a Mixed default model", async () => {
    twoEnvironments(
      { defaultModelSelection: GPT_54, defaultRuntimeMode: "full-access" },
      { defaultModelSelection: CLAUDE_OPUS, defaultRuntimeMode: "full-access" },
    );
    await mountSettings("general");
    expect(rowTrigger("default-model").textContent).toContain("Mixed");
    await openRowPicker("default-permissions");
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(searchInput().closest("[hidden][inert]")).toBeTruthy();
    await chooseOption("Access level", "Supervised");
    await click(moreOptionsToggle()!);
    expect(searchInput().closest("[hidden]")).toBeNull();
    expect(document.activeElement).toBe(searchInput());
    await openMoreOptions();
    expect(
      extrasRegion()?.querySelector<HTMLSelectElement>('[aria-label="Access level"]')?.value,
    ).toBe("approval-required");
    expect(fixture.writes).toEqual([]);
    await click(useButton());

    expect(fixture.writes.map((write) => write.patch)).toEqual([
      { defaultRuntimeMode: "approval-required" },
      { defaultRuntimeMode: "approval-required" },
    ]);
    expect(serverSettings(LAPTOP).defaultModelSelection).toEqual(GPT_54);
    expect(serverSettings(SERVER).defaultModelSelection).toEqual(CLAUDE_OPUS);
  });

  it("settings combined picker: a project access edit keeps the inherited default model", async () => {
    await mountProjectScope({ defaultModelSelection: GPT_54, defaultRuntimeMode: "full-access" });
    await openRowPicker("default-permissions");
    await chooseOption("Access level", "Auto");
    await click(useButton());

    expect(fixture.writes).toHaveLength(1);
    expect(projectOverride(LAPTOP)).toEqual({ defaultRuntimeMode: "auto" });
    expect(serverSettings(LAPTOP).defaultModelSelection).toEqual(GPT_54);
  });

  it("settings combined picker: a Mixed default model keeps the access summary its own", async () => {
    twoEnvironments(
      { defaultModelSelection: GPT_54, defaultRuntimeMode: "auto" },
      { defaultModelSelection: CLAUDE_OPUS, defaultRuntimeMode: "auto" },
    );
    await mountSettings("general");
    expect(rowTrigger("default-model").textContent).toContain("Mixed");
    expect(rowTrigger("default-permissions").textContent).toContain("Auto");
    expect(rowTrigger("default-permissions").textContent).not.toContain("Mixed");
    await openRowPicker("default-model");
    expect(accessSummary()).toContain("Auto");
    expect(accessSummary()).not.toContain("Mixed");
  });

  it("settings combined picker: Mixed default access shows Mixed in Permissions and in the picker", async () => {
    twoEnvironments(
      { defaultModelSelection: GPT_54, defaultRuntimeMode: "auto" },
      { defaultModelSelection: GPT_54, defaultRuntimeMode: "approval-required" },
    );
    await mountSettings("general");
    expect(rowTrigger("default-permissions").textContent).toContain("Mixed");
    expect(rowTrigger("default-model").textContent).not.toContain("Mixed");
    await openRowPicker("default-permissions");
    expect(accessSummary()).toContain("Mixed");
    const access = control("Access level") as HTMLSelectElement | null;
    expect(access?.selectedOptions[0]?.textContent?.trim()).toBe("Mixed");
  });

  it("settings combined picker: Escape after editing a default discards effort, options, and access", async () => {
    setEnvironments([
      environment(LAPTOP, "Laptop", {
        defaultModelSelection: GPT_54,
        defaultRuntimeMode: "approval-required",
      }),
    ]);
    await mountSettings("general");
    await openRowPicker("default-model");
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");
    expect(effortValue("GPT-5.4")).toBe("High");
    await openMoreOptions();
    await chooseOption("Service tier", "Fast");
    await chooseOption("Access level", "Full access");
    await press(searchInput(), "Escape");

    expect(pickerContent()).toBeNull();
    expect(fixture.writes).toEqual([]);
    await openRowPicker("default-model");
    expect(effortValue("GPT-5.4")).toBe("Medium");
    expect(accessSummary()).toContain("Supervised");
  });

  it("settings combined picker: a default model missing on one environment is rejected before any write", async () => {
    twoEnvironments(
      { defaultModelSelection: GPT_54, defaultRuntimeMode: "full-access" },
      { defaultModelSelection: GPT_54, defaultRuntimeMode: "full-access" },
      [
        fixture.provider("codex", "codex", [fixture.codexModels[0]]),
        fixture.provider("claudeAgent", "claudeAgent", fixture.claudeModels),
      ],
    );
    await mountSettings("general");
    await openRowPicker("default-model");
    await openMoreOptions();
    await chooseOption("Access level", "Supervised");
    await click(row("GPT-5.5"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(fixture.writes).toEqual([]);
    expect(serverSettings(LAPTOP).defaultRuntimeMode).toBe("full-access");
    expect(serverSettings(SERVER).defaultModelSelection).toEqual(GPT_54);
  });

  it("settings combined picker: keyboard alone edits and applies a Settings default", async () => {
    await mountSettings("general");
    await openRowPicker("default-model");
    await highlight("GPT-5.5");
    await press(searchInput(), "ArrowLeft");
    expect(effortValue("GPT-5.5")).toBe("Medium");
    await press(searchInput(), "Enter");

    expect(pickerContent()).toBeNull();
    expect(serverSettings(LAPTOP).defaultModelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });
});

describe("settings combined picker new-thread guards", () => {
  it("settings combined picker guard: resetting the project model override keeps the access override", async () => {
    await mountProjectScope({
      projectSettingsOverrides: {
        [PROJECT]: { defaultModelSelection: GPT_54, defaultRuntimeMode: "auto" },
      },
    } as SettingsOverrides);
    await click(buttonByLabel(/^Reset Model/, settingsRow("default-model"))!);

    expect(fixture.writes).toHaveLength(1);
    expect(projectOverride(LAPTOP)).toEqual({ defaultRuntimeMode: "auto" });
  });

  it("settings combined picker guard: resetting the project access override keeps the model override", async () => {
    await mountProjectScope({
      projectSettingsOverrides: {
        [PROJECT]: { defaultModelSelection: GPT_54, defaultRuntimeMode: "auto" },
      },
    } as SettingsOverrides);
    await click(buttonByLabel(/^Reset Permissions/, settingsRow("default-permissions"))!);

    expect(fixture.writes).toHaveLength(1);
    expect(projectOverride(LAPTOP)).toEqual({ defaultModelSelection: GPT_54 });
  });

  it("settings combined picker guard: environment resets clear only their own default", async () => {
    setEnvironments([
      environment(LAPTOP, "Laptop", {
        defaultModelSelection: GPT_54,
        defaultRuntimeMode: "auto",
      }),
    ]);
    await mountSettings("general");
    await click(buttonByLabel(/^Reset default model/, settingsRow("default-model"))!);
    expect(fixture.writes.map((write) => write.patch)).toEqual([{ defaultModelSelection: null }]);
    expect(serverSettings(LAPTOP).defaultRuntimeMode).toBe("auto");

    await click(buttonByLabel(/^Reset default permissions/, settingsRow("default-permissions"))!);
    expect(fixture.writes.map((write) => write.patch)).toEqual([
      { defaultModelSelection: null },
      { defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode },
    ]);
  });
});

describe("settings combined picker text generation", () => {
  it("settings combined picker: text generation saves consumed options and shows the rest read-only", async () => {
    await mountSettings("general");
    await openRowPicker("text-generation-model");
    expect(effortValue("GPT-5.4")).not.toBeNull();
    await highlight("GPT-5.4");
    await openMoreOptions();

    const region = extrasRegion()!;
    expect(region.textContent).toContain("Managed by task");
    const access = control("Access level");
    expect(access === null || access.hasAttribute("disabled")).toBe(true);
    const contextWindow = control("Context window");
    expect(contextWindow, "Unconsumed options stay visible").toBeTruthy();
    expect(contextWindow!.hasAttribute("disabled")).toBe(true);
    expect(control("Service tier")?.hasAttribute("disabled")).toBe(false);

    await chooseOption("Service tier", "Fast");
    await click(useButton());

    expect(fixture.writes).toHaveLength(1);
    expect(Object.keys(fixture.writes[0]!.patch)).toEqual(["textGenerationModelSelection"]);
    expect(serverSettings(LAPTOP).textGenerationModelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.4",
      options: expect.arrayContaining([{ id: "serviceTier", value: "priority" }]),
    });
  });

  it("settings combined picker: Settings show Ultrathink effort but never apply it", async () => {
    setEnvironments([environment(LAPTOP, "Laptop", { textGenerationModelSelection: CLAUDE_OPUS })]);
    await mountSettings("general");
    await openRowPicker("text-generation-model");
    await highlight("Claude Opus 5");
    for (let step = 0; step < 4; step += 1) await press(searchInput(), "ArrowRight");
    expect(effortValue("Claude Opus 5")).toBe("High");
    await openMoreOptions();
    expect(extrasRegion()?.textContent).toMatch(/Ultrathink/);
    // More options focuses its first control, so apply through its Use button.
    await click(useButton());

    const saved = serverSettings(LAPTOP).textGenerationModelSelection;
    expect(saved?.options).toEqual(expect.arrayContaining([{ id: "effort", value: "high" }]));
    expect(saved?.options).not.toEqual(
      expect.arrayContaining([{ id: "effort", value: "ultrathink" }]),
    );
  });

  it("settings combined picker: cancelling a text generation edit writes nothing", async () => {
    await mountSettings("general");
    await openRowPicker("text-generation-model");
    const before = effortValue("GPT-5.4");
    expect(before).not.toBeNull();
    await click(effortButton("Increase", "GPT-5.4"));
    expect(effortValue("GPT-5.4")).not.toBe(before);
    await pressOutside();

    expect(pickerContent()).toBeNull();
    expect(fixture.writes).toEqual([]);
    await openRowPicker("text-generation-model");
    expect(effortValue("GPT-5.4")).toBe(before);
  });

  it("settings combined picker guard: text generation without a provider still explains why", async () => {
    setEnvironments([
      environment(LAPTOP, "Laptop", {}, [
        {
          ...fixture.provider("codex", "codex", fixture.codexModels),
          supportsTextGeneration: false,
        },
      ]),
    ]);
    await mountSettings("general");
    expect(settingsRow("text-generation-model").textContent).toContain(
      "No text generation providers available.",
    );
  });
});

describe("settings combined picker source-control writing", () => {
  const WRITER: ModelSelection = {
    instanceId: "codex" as never,
    model: "gpt-5.4",
    options: [
      { id: "contextWindow", value: "1m" },
      { id: "reasoningEffort", value: "low" },
    ],
  };

  it("settings combined picker: source-control writer keeps saved options and shows the full picker", async () => {
    setEnvironments([environment(LAPTOP, "Laptop", { sourceControlWriterModelSelection: WRITER })]);
    await mountSettings("source-control");
    await openRowPicker("source-control-writer-model");
    expect(effortValue("GPT-5.4")).toBe("Low");
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");
    await openMoreOptions();
    expect(extrasRegion()?.textContent).toContain("Managed by task");
    expect(control("Context window")?.hasAttribute("disabled")).toBe(true);
    await click(row("GPT-5.4"));

    expect(fixture.writes.map((write) => Object.keys(write.patch))).toEqual([
      ["sourceControlWriterModelSelection"],
    ]);
    expect(serverSettings(LAPTOP).sourceControlWriterModelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.4",
      options: expect.arrayContaining([
        { id: "contextWindow", value: "1m" },
        { id: "reasoningEffort", value: "medium" },
      ]),
    });
  });

  it("settings combined picker: a writer model missing on one environment is rejected before any write", async () => {
    twoEnvironments(
      { sourceControlWriterModelSelection: WRITER },
      { sourceControlWriterModelSelection: WRITER },
      [
        fixture.provider("codex", "codex", [fixture.codexModels[0]]),
        fixture.provider("claudeAgent", "claudeAgent", fixture.claudeModels),
      ],
    );
    await mountSettings("source-control");
    await openRowPicker("source-control-writer-model");
    await openMoreOptions();
    await click(row("GPT-5.5"));

    expect(fixture.writes).toEqual([]);
    expect(serverSettings(SERVER).sourceControlWriterModelSelection).toEqual(WRITER);
  });

  it("settings combined picker: dismissing the writer picker after an edit writes nothing", async () => {
    setEnvironments([environment(LAPTOP, "Laptop", { sourceControlWriterModelSelection: WRITER })]);
    await mountSettings("source-control");
    await openRowPicker("source-control-writer-model");
    await click(effortButton("Increase", "GPT-5.4"));
    expect(effortValue("GPT-5.4")).toBe("Medium");
    await press(searchInput(), "Escape");

    expect(fixture.writes).toEqual([]);
    expect(serverSettings(LAPTOP).sourceControlWriterModelSelection).toEqual(WRITER);
  });

  it("settings combined picker guard: turning off the dedicated writer falls back to text generation", async () => {
    setEnvironments([environment(LAPTOP, "Laptop", { sourceControlWriterModelSelection: WRITER })]);
    await mountSettings("source-control");
    const toggle = settingsRow("source-control-writer-model").querySelector<HTMLElement>(
      '[aria-label="Use a separate source control writer model"]',
    );
    expect(toggle).toBeTruthy();
    await click(toggle!);

    expect(fixture.writes.map((write) => write.patch)).toEqual([
      { sourceControlWriterModelSelection: null },
    ]);
    expect(
      settingsRow("source-control-writer-model").querySelector(
        '[data-chat-provider-model-picker="true"]',
      ),
    ).toBeNull();
  });

  it("settings combined picker guard: enabling the dedicated writer copies the text generation choice", async () => {
    const textGeneration: ModelSelection = {
      instanceId: "codex" as never,
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    setEnvironments([
      environment(LAPTOP, "Laptop", { textGenerationModelSelection: textGeneration }),
    ]);
    await mountSettings("source-control");
    const toggle = settingsRow("source-control-writer-model").querySelector<HTMLElement>(
      '[aria-label="Use a separate source control writer model"]',
    );
    await click(toggle!);

    expect(serverSettings(LAPTOP).sourceControlWriterModelSelection).toEqual(textGeneration);
  });
});

function selectedRailLabel() {
  const selected = pickerContent()?.querySelector<HTMLElement>(
    '[data-model-picker-sidebar] button[aria-pressed="true"]',
  );
  return selected?.getAttribute("aria-label") ?? selected?.textContent ?? null;
}

function focusTarget(): EventTarget {
  return document.activeElement ?? document.body;
}

function applyAccessButton() {
  const button = buttonByLabel("Apply access", pickerContent() ?? document);
  expect(button, "Expected the access-only apply button in More options").toBeTruthy();
  return button!;
}

describe("settings combined picker keyboard and access independence", () => {
  it("settings combined picker: Alt+E reaches More options by keyboard while Tab keeps cycling providers", async () => {
    await mountSettings("general");
    await openRowPicker("default-model");
    expect(selectedRailLabel()).toBe("Codex");

    await press(focusTarget(), "Tab");
    expect(selectedRailLabel()).toBe("Claude");
    expect(document.activeElement).toBe(searchInput());
    await press(focusTarget(), "Tab", { shiftKey: true });
    expect(selectedRailLabel()).toBe("Codex");
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");

    await press(focusTarget(), "e", { altKey: true, code: "KeyE" });
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(extrasRegion()?.contains(document.activeElement)).toBe(true);

    await press(focusTarget(), "e", { altKey: true, code: "KeyE" });
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(searchInput());
    expect(fixture.writes).toEqual([]);
  });

  it("settings combined picker: Permissions stays editable when no provider is selectable", async () => {
    setEnvironments([environment(LAPTOP, "Laptop", { defaultRuntimeMode: "auto" }, [])]);
    await mountSettings("general");
    expect(settingsRow("default-model").textContent).toContain("No providers available");
    expect(rowTrigger("default-permissions").textContent).toContain("Auto");

    await openRowPicker("default-permissions");
    expect(applyAccessButton().disabled).toBe(true);
    await chooseOption("Access level", "Supervised");
    await click(applyAccessButton());

    expect(pickerContent()).toBeNull();
    expect(fixture.writes.map((write) => write.patch)).toEqual([
      { defaultRuntimeMode: "approval-required" },
    ]);
  });

  it("settings combined picker: Permissions shows Mixed without a selectable provider", async () => {
    setEnvironments([
      environment(LAPTOP, "Laptop", { defaultRuntimeMode: "auto" }, []),
      environment(SERVER, "Server", { defaultRuntimeMode: "full-access" }, []),
    ]);
    await mountSettings("general");
    expect(rowTrigger("default-permissions").textContent).toContain("Mixed");
    await openRowPicker("default-permissions");
    expect(accessSummary()).toContain("Mixed");
  });

  it("settings combined picker: an access edit applies when the saved default model left the catalog", async () => {
    const removed: ModelSelection = { instanceId: "codex" as never, model: "removed-model" };
    setEnvironments([
      environment(LAPTOP, "Laptop", {
        defaultModelSelection: removed,
        defaultRuntimeMode: "full-access",
      }),
    ]);
    await mountSettings("general");
    await openRowPicker("default-permissions");
    await chooseOption("Access level", "Supervised");
    await click(applyAccessButton());

    expect(fixture.writes.map((write) => write.patch)).toEqual([
      { defaultRuntimeMode: "approval-required" },
    ]);
    expect(serverSettings(LAPTOP).defaultModelSelection).toEqual(removed);
  });

  it("settings combined picker: an access edit under Favorites never selects a favorite model", async () => {
    fixture.favorites = [{ provider: "codex", model: "gpt-5.5" }];
    setEnvironments([
      environment(LAPTOP, "Laptop", {
        defaultModelSelection: GPT_54,
        defaultRuntimeMode: "full-access",
      }),
    ]);
    await mountSettings("general");
    await openRowPicker("default-permissions");
    await click(moreOptionsToggle()!);
    expect(selectedRailLabel()).toBe("Favorites");
    await openMoreOptions();
    await chooseOption("Access level", "Supervised");
    await click(applyAccessButton());

    expect(fixture.writes.map((write) => write.patch)).toEqual([
      { defaultRuntimeMode: "approval-required" },
    ]);
    expect(serverSettings(LAPTOP).defaultModelSelection).toEqual(GPT_54);
  });

  it("settings combined picker guard: choosing a visible model from the access opening still writes that model", async () => {
    setEnvironments([
      environment(LAPTOP, "Laptop", {
        defaultModelSelection: { instanceId: "codex" as never, model: "removed-model" },
        defaultRuntimeMode: "full-access",
      }),
    ]);
    await mountSettings("general");
    await openRowPicker("default-permissions");
    await click(row("GPT-5.5"));

    expect(fixture.writes.map((write) => Object.keys(write.patch))).toEqual([
      ["defaultModelSelection"],
    ]);
    expect(serverSettings(LAPTOP).defaultModelSelection?.model).toBe("gpt-5.5");
  });
});

describe("settings combined picker legacy Codex Fast", () => {
  const LEGACY_FAST: ModelSelection = {
    instanceId: "codex" as never,
    model: "gpt-5.4",
    options: [
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
    ],
  };
  const PAGES = [
    { page: "general", rowId: "default-model", key: "defaultModelSelection" },
    { page: "general", rowId: "text-generation-model", key: "textGenerationModelSelection" },
    {
      page: "source-control",
      rowId: "source-control-writer-model",
      key: "sourceControlWriterModelSelection",
    },
  ] as const;

  it.each(PAGES)(
    "settings combined picker: $rowId shows legacy Fast and keeps it through an effort-only edit",
    async ({ page, rowId, key }) => {
      setEnvironments([environment(LAPTOP, "Laptop", { [key]: LEGACY_FAST })]);
      await mountSettings(page);
      await openRowPicker(rowId);
      await highlight("GPT-5.4");
      await openMoreOptions();
      expect((control("Service tier") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
        "Fast",
      );
      await click(effortButton("Increase", "GPT-5.4"));
      await click(useButton());

      const saved = serverSettings(LAPTOP)[key];
      expect(fixture.writes).toHaveLength(1);
      expect(saved?.options).toContainEqual({ id: "reasoningEffort", value: "medium" });
      expect(saved?.options).toContainEqual({ id: "fastMode", value: true });
      expect(saved?.options?.some((option) => option.id === "serviceTier")).toBe(false);
    },
  );

  it.each(PAGES)(
    "settings combined picker: $rowId writes an explicit Standard tier over legacy Fast",
    async ({ page, rowId, key }) => {
      setEnvironments([environment(LAPTOP, "Laptop", { [key]: LEGACY_FAST })]);
      await mountSettings(page);
      await openRowPicker(rowId);
      await highlight("GPT-5.4");
      await openMoreOptions();
      await chooseOption("Service tier", "Standard");
      await click(useButton());

      expect(serverSettings(LAPTOP)[key]?.options).toContainEqual({
        id: "serviceTier",
        value: "default",
      });
    },
  );
});

describe("settings combined picker aggregate text generation support", () => {
  it("settings combined picker: writing rejects a provider that cannot generate text on one target", async () => {
    twoEnvironments({}, {}, [
      { ...fixture.provider("codex", "codex", fixture.codexModels), supportsTextGeneration: false },
      fixture.provider("claudeAgent", "claudeAgent", fixture.claudeModels),
    ]);
    await mountSettings("general");
    await openRowPicker("text-generation-model");
    await click(row("GPT-5.5"));

    expect(fixture.writes).toEqual([]);
  });

  it("settings combined picker guard: writing accepts a provider every target can use for text", async () => {
    twoEnvironments({}, {});
    await mountSettings("general");
    await openRowPicker("text-generation-model");
    await click(row("GPT-5.5"));

    expect(fixture.writes.map((write) => write.environmentId)).toEqual([LAPTOP, SERVER]);
  });

  it("settings combined picker guard: new-thread defaults ignore text generation support", async () => {
    twoEnvironments({}, {}, [
      { ...fixture.provider("codex", "codex", fixture.codexModels), supportsTextGeneration: false },
      fixture.provider("claudeAgent", "claudeAgent", fixture.claudeModels),
    ]);
    await mountSettings("general");
    await openRowPicker("default-model");
    await click(row("GPT-5.5"));

    expect(fixture.writes.map((write) => write.environmentId)).toEqual([LAPTOP, SERVER]);
  });
});

describe("settings combined picker regression coverage", () => {
  it("settings combined picker: the composer.effort alias toggles More options in Settings", async () => {
    await mountSettings("general");
    await openRowPicker("default-model");

    await press(focusTarget(), "Y", { altKey: true, shiftKey: true, code: "KeyY" });
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(extrasRegion()?.contains(document.activeElement)).toBe(true);

    await press(focusTarget(), "Y", { altKey: true, shiftKey: true, code: "KeyY" });
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(searchInput());
  });

  it("settings combined picker: Tab inside expanded More options keeps normal focus order", async () => {
    await mountSettings("general");
    await openRowPicker("default-model");
    await press(focusTarget(), "e", { altKey: true, code: "KeyE" });
    expect(extrasRegion()?.contains(document.activeElement)).toBe(true);

    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        focusTarget().dispatchEvent(event);
      });
      expect(event.defaultPrevented, "Tab in More options must reach the browser").toBe(false);
    }
    await click(moreOptionsToggle()!);
    expect(selectedRailLabel()).toBe("Codex");
  });

  it("settings combined picker: a project access edit with no model row keeps the inherited model and options", async () => {
    const inherited: ModelSelection = {
      instanceId: "codex" as never,
      model: "removed-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    await mountProjectScope({
      defaultModelSelection: inherited,
      defaultRuntimeMode: "full-access",
    });
    await openRowPicker("default-permissions");
    await chooseOption("Access level", "Auto");
    await click(applyAccessButton());

    expect(fixture.writes).toHaveLength(1);
    expect(projectOverride(LAPTOP)).toEqual({ defaultRuntimeMode: "auto" });
    expect(serverSettings(LAPTOP).defaultModelSelection).toEqual(inherited);
  });

  it("settings combined picker: the writer rejects a provider that cannot generate text on one target", async () => {
    const writer: ModelSelection = { instanceId: "codex" as never, model: "gpt-5.4" };
    twoEnvironments(
      { sourceControlWriterModelSelection: writer },
      { sourceControlWriterModelSelection: writer },
      [
        {
          ...fixture.provider("codex", "codex", fixture.codexModels),
          supportsTextGeneration: false,
        },
        fixture.provider("claudeAgent", "claudeAgent", fixture.claudeModels),
      ],
    );
    await mountSettings("source-control");
    await openRowPicker("source-control-writer-model");
    await click(row("GPT-5.5"));

    expect(fixture.writes).toEqual([]);
  });
});

describe("settings combined picker legacy Fast without an advertised Fast tier", () => {
  // A legal custom catalog: the Codex service tier lists no option with the id
  // `fast` or the label Fast. The backend still runs saved legacy
  // `fastMode: true` on its "fast" tier until an explicit tier overrides it.
  const flexOnlyModels = [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
          {
            id: "serviceTier",
            label: "Service tier",
            type: "select",
            options: [
              { id: "default", label: "Standard", isDefault: true },
              { id: "flex", label: "Flex" },
            ],
          },
        ],
      },
    },
  ];
  const LEGACY_FAST: ModelSelection = {
    instanceId: "codex" as never,
    model: "gpt-5.4",
    options: [
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
    ],
  };
  const PAGES = [
    { page: "general", rowId: "default-model", key: "defaultModelSelection" },
    { page: "general", rowId: "text-generation-model", key: "textGenerationModelSelection" },
    {
      page: "source-control",
      rowId: "source-control-writer-model",
      key: "sourceControlWriterModelSelection",
    },
  ] as const;

  async function mountLegacy(page: "general" | "source-control", key: string, rowId: string) {
    setEnvironments([
      environment(LAPTOP, "Laptop", { [key]: LEGACY_FAST }, [
        fixture.provider("codex", "codex", flexOnlyModels),
      ]),
    ]);
    await mountSettings(page);
    await openRowPicker(rowId);
    await highlight("GPT-5.4");
    await openMoreOptions();
  }

  it.each(PAGES)(
    "settings combined picker: $rowId keeps unadvertised legacy Fast through an effort-only edit",
    async ({ page, rowId, key }) => {
      await mountLegacy(page, key, rowId);
      await click(effortButton("Increase", "GPT-5.4"));
      await click(useButton());

      const saved = serverSettings(LAPTOP)[key];
      expect(fixture.writes).toHaveLength(1);
      expect(saved?.options).toContainEqual({ id: "reasoningEffort", value: "medium" });
      expect(saved?.options).toContainEqual({ id: "fastMode", value: true });
      expect(saved?.options?.some((option) => option.id === "serviceTier")).toBe(false);
    },
  );

  it.each(PAGES)(
    "settings combined picker: $rowId does not show unadvertised legacy Fast as Standard",
    async ({ page, rowId, key }) => {
      await mountLegacy(page, key, rowId);
      const tier = control("Service tier") as HTMLSelectElement;
      expect(tier.selectedOptions[0]?.textContent).toMatch(/fast/i);
    },
  );

  it.each(PAGES)(
    "settings combined picker: $rowId moves from the unadvertised legacy entry to Standard and back",
    async ({ page, rowId, key }) => {
      await mountLegacy(page, key, rowId);
      const tier = control("Service tier") as HTMLSelectElement;
      // A browser fires change only when the chosen option differs from the
      // selected one, so Standard must not already be selected.
      expect(tier.value).not.toBe("default");
      expect(tier.selectedOptions[0]?.disabled).toBe(false);
      expect([...tier.options].find((option) => option.value === "default")?.disabled).toBe(false);

      await chooseOption("Service tier", "Standard");
      expect((control("Service tier") as HTMLSelectElement).value).toBe("default");
      await chooseOption("Service tier", "Fast (legacy)");
      await click(useButton());

      const saved = serverSettings(LAPTOP)[key];
      expect(saved?.options).toContainEqual({ id: "fastMode", value: true });
      expect(saved?.options?.some((option) => option.id === "serviceTier")).toBe(false);
    },
  );

  it.each(PAGES)(
    "settings combined picker: $rowId writes an explicit Standard tier over unadvertised legacy Fast",
    async ({ page, rowId, key }) => {
      await mountLegacy(page, key, rowId);
      await chooseOption("Service tier", "Standard");
      await click(useButton());

      expect(serverSettings(LAPTOP)[key]?.options).toContainEqual({
        id: "serviceTier",
        value: "default",
      });
    },
  );
});
