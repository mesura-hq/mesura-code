// @vitest-environment happy-dom
/**
 * Entry point: AppRoot with its memory router, real ChatView, ChatComposer,
 * ProviderModelPicker, and ModelPickerContent. Environment reads and RPC
 * commands use the fixture below. Layout measurement (clientWidth and the
 * resting-layout decision) and the virtual list's measurement are test
 * boundaries, because happy-dom has no layout.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { Thread } from "./types";
import type { CombinedPickerCandidate } from "./components/chat/combinedPickerState";
import type { AppRouter } from "./router";

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
              { id: "xhigh", label: "Extra High" },
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
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
              { id: "max", label: "Max" },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            promptInjectedValues: ["ultrathink"],
          },
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
    workspaceSnapshots: [{ cwd: "/tmp/combined-picker", skills: [], slashCommands: [] }],
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T12:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  });
  return {
    thread: null as Thread | null,
    width: 1200,
    forceResting: false,
    planModeEnabled: false,
    defaultRuntimeMode: null as RuntimeMode | null,
    applySelection: null as ((candidate: CombinedPickerCandidate) => boolean) | null,
    holdApply: false,
    heldCandidate: null as CombinedPickerCandidate | null,
    commands: new Map<unknown, unknown>(),
    noopCommand: vi.fn(async () => ({ _tag: "Success", value: undefined })),
    refresh: vi.fn(),
    empty: [],
    threadListeners: new Set<() => void>(),
    codexProvider: provider("codex", "codex", codexModels),
    claudeProvider: provider("claudeAgent", "claudeAgent", claudeModels),
    environments: [
      {
        environmentId: "combined-picker-environment",
        label: "Combined picker environment",
        connection: { phase: "connected" },
        serverConfig: {
          environment: {
            platform: { machine: "server" },
            capabilities: {
              questionAttachments: true,
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 1048576 },
            },
          },
          providers: [] as unknown[],
          // The draft hero reads the environment's machine kind.
          settings: {},
        },
      },
    ],
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
    useProject: () => ({
      id: "combined-picker-project",
      environmentId: "combined-picker-environment",
      title: "Combined picker",
      workspaceRoot: "/tmp/combined-picker",
      scripts: [],
      createdAt: "2026-10-05T12:00:00.000Z",
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    }),
  };
});
vi.mock("./state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments, isReady: true }),
  usePrimaryEnvironment: () => null,
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
vi.mock("./state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
// composer.effort has no default binding in this fork. Bind it here so the
// alias path through ChatView's real shortcut handler stays exercisable.
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
vi.mock("./components/composerFooterLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/composerFooterLayout")>();
  return {
    ...actual,
    shouldUseRestingComposerLayout: (
      input: Parameters<typeof actual.shouldUseRestingComposerLayout>[0],
    ) => fixture.forceResting || actual.shouldUseRestingComposerLayout(input),
  };
});
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => fixture.commands.get(command) ?? fixture.noopCommand,
}));
vi.mock("./state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => fixture.noopCommand }));
vi.mock("./hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  const planSettings = { ...settings, planModeEnabled: true };
  // One stable object per default, so settings identity changes only with it.
  const settingsByDefaultRuntimeMode = new Map<RuntimeMode, typeof settings>();
  const withDefaultRuntimeMode = (mode: RuntimeMode) => {
    if (!settingsByDefaultRuntimeMode.has(mode)) {
      settingsByDefaultRuntimeMode.set(mode, { ...settings, defaultRuntimeMode: mode });
    }
    return settingsByDefaultRuntimeMode.get(mode)!;
  };
  return {
    ...(await importOriginal<typeof import("./hooks/useSettings")>()),
    useEnvironmentSettings: () =>
      fixture.defaultRuntimeMode
        ? withDefaultRuntimeMode(fixture.defaultRuntimeMode)
        : fixture.planModeEnabled
          ? planSettings
          : settings,
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
  };
});
// Renders the real composer and records ChatView's real apply handler. While
// `holdApply` is set, the real picker's next candidate is held instead of
// delivered, so a test can hand it to that handler after the catalog changed.
vi.mock("./components/chat/ChatComposer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/chat/ChatComposer")>();
  const { useLayoutEffect } = await import("react");
  const RealChatComposer = actual.ChatComposer;
  function ChatComposer(props: Parameters<typeof RealChatComposer>[0]) {
    useLayoutEffect(() => {
      fixture.applySelection = props.onProviderSelectionApply;
    });
    const onProviderSelectionApply = (candidate: CombinedPickerCandidate) => {
      if (!fixture.holdApply) return props.onProviderSelectionApply(candidate);
      fixture.heldCandidate = candidate;
      return false;
    };
    return <RealChatComposer {...props} onProviderSelectionApply={onProviderSelectionApply} />;
  }
  return { ...actual, ChatComposer };
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
// The branch toolbar owns the context strip that hosts resting composer
// controls. Keep only that host element; the branch UI is out of scope.
vi.mock("./components/BranchToolbar", () => ({
  BranchToolbar: (props: { composerControlsHostRef?: (host: HTMLDivElement | null) => void }) => (
    <div data-combined-picker-resting-host ref={props.composerControlsHostRef} />
  ),
}));
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
import ChatView from "./components/ChatView";
import { SidebarProvider } from "./components/ui/sidebar";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";

const environmentId = EnvironmentId.make("combined-picker-environment");
const threadId = ThreadId.make("combined-picker-thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const now = "2026-10-05T12:00:00.000Z";
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const draftId = DraftId.make("combined-picker-draft");
const draftThreadId = ThreadId.make("combined-picker-draft-thread");
const baseEnvironment = fixture.environments[0]!;
let root: Root | undefined;
let container: HTMLDivElement;
let clientWidthDescriptor: PropertyDescriptor | undefined;

function makeThread(runtimeMode: RuntimeMode): Thread {
  return {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("combined-picker-project"),
    title: "Combined picker",
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode,
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
    branch: null,
    worktreePath: null,
    activities: [],
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.width = 1200;
  fixture.forceResting = false;
  fixture.planModeEnabled = false;
  fixture.defaultRuntimeMode = null;
  fixture.applySelection = null;
  fixture.holdApply = false;
  fixture.heldCandidate = null;
  fixture.environments = [baseEnvironment];
  fixture.environments[0]!.serverConfig.providers = [
    { ...fixture.codexProvider },
    { ...fixture.claudeProvider },
  ];
  fixture.thread = makeThread("approval-required");
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  useComposerDraftStore.getState().setPrompt(threadRef, "Keep this prompt");
  clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => fixture.width,
  });
  // happy-dom has no FontFaceSet. The resting layout re-measures on font loads.
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
  if (clientWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
  } else {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountApp(chatRoute: "server" | "draft" = "server") {
  const route = createRootRoute({
    component: () => (
      <SidebarProvider>
        {chatRoute === "draft" ? (
          <ChatView
            environmentId={environmentId}
            threadId={draftThreadId}
            routeKind="draft"
            draftId={draftId}
          />
        ) : (
          <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
        )}
      </SidebarProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => route, path: "/" });
  const router = createRouter({
    routeTree: route.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
}

function draft() {
  return useComposerDraftStore.getState().getComposerDraft(threadRef);
}

function savedSnapshot() {
  const current = draft();
  return {
    modelSelectionByProvider: current?.modelSelectionByProvider ?? {},
    activeProvider: current?.activeProvider ?? null,
    runtimeMode: current?.runtimeMode ?? null,
    prompt: current?.prompt ?? "",
    sticky: useComposerDraftStore.getState().stickyModelSelectionByProvider,
  };
}

function pickerContent() {
  return document.querySelector<HTMLElement>("[data-model-picker-content]");
}

function searchInput() {
  const input = pickerContent()?.querySelector<HTMLInputElement>("input");
  expect(input, "Expected the model picker search input").toBeTruthy();
  return input!;
}

function modelTrigger() {
  const triggers = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
  ].filter((trigger) => !trigger.closest("[inert]"));
  expect(triggers.length, "Expected one visible composer model trigger").toBeGreaterThan(0);
  return triggers[0]!;
}

function rows() {
  return [...(pickerContent()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

function row(name: string) {
  const match = rows().find((entry) => entry.textContent?.includes(name));
  expect(
    match,
    `Expected model row ${name}; rendered: ${pickerContent()?.textContent}`,
  ).toBeTruthy();
  return match!;
}

function highlightedRow() {
  return rows().find((entry) => entry.hasAttribute("data-highlighted")) ?? null;
}

function effortValue(name: string) {
  return (
    row(name).querySelector("[data-combined-picker-effort-value]")?.textContent?.trim() ?? null
  );
}

function selectedRailLabel() {
  const selected = pickerContent()?.querySelector<HTMLElement>(
    '[data-model-picker-sidebar] button[aria-pressed="true"]',
  );
  return selected?.getAttribute("aria-label") ?? selected?.textContent ?? null;
}

function buttonByLabel(label: string | RegExp, scope: ParentNode = document) {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
      const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof label === "string" ? name.trim() === label : label.test(name.trim());
    }) ?? null
  );
}

function moreOptionsToggle() {
  return buttonByLabel(/^More options/, pickerContent() ?? document);
}

async function press(target: EventTarget, key: string, init: Omit<KeyboardEventInit, "key"> = {}) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function openPicker() {
  await click(modelTrigger());
  expect(pickerContent(), "Expected the model picker to open").toBeTruthy();
}

async function typeSearch(value: string) {
  const input = searchInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Whether an element or one of its descendants is labelled exactly `label`. */
function hasExactLabel(element: Element, label: string) {
  return [element, ...element.querySelectorAll("*")].some(
    (node) => node.textContent?.trim() === label,
  );
}

/** Chooses a value in a labelled control without assuming its widget type. */
async function chooseOption(controlLabel: string, optionLabel: string) {
  const scope = pickerContent()!;
  const control = scope.querySelector<HTMLElement>(`[aria-label="${controlLabel}"]`);
  expect(control, `Expected control ${controlLabel}; rendered: ${scope.textContent}`).toBeTruthy();
  if (control instanceof HTMLSelectElement) {
    const option = [...control.options].find((entry) => entry.textContent?.trim() === optionLabel);
    expect(option, `Expected option ${optionLabel} in ${controlLabel}`).toBeTruthy();
    await act(async () => {
      control.value = option!.value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return;
  }
  const modelRows = new Set<Element>(rows());
  const findChoice = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="radio"], [role="option"], [role="menuitemradio"]',
      ),
    ].find((entry) => !modelRows.has(entry) && hasExactLabel(entry, optionLabel));
  let choice = [...control!.querySelectorAll<HTMLElement>('[role="radio"]')].find((entry) =>
    hasExactLabel(entry, optionLabel),
  );
  if (!choice) {
    await click(control!);
    choice = findChoice();
  }
  expect(choice, `Expected choice ${optionLabel} for ${controlLabel}`).toBeTruthy();
  await click(choice!);
}

async function openMoreOptions() {
  const toggle = moreOptionsToggle();
  expect(toggle, "Expected one More options disclosure in the picker").toBeTruthy();
  await click(toggle!);
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");
}

function accessSummary() {
  return moreOptionsToggle()?.textContent ?? "";
}

type ComposerLayout = "expanded" | "compact" | "resting";

function useComposerLayout(layout: ComposerLayout) {
  fixture.width = layout === "compact" ? 300 : 1200;
  fixture.forceResting = layout === "resting";
}

function expectComposerLayout(layout: ComposerLayout) {
  if (layout === "resting") {
    expect(container.querySelector('[data-chat-composer-resting-controls="true"]')).toBeTruthy();
    return;
  }
  expect(
    container
      .querySelector("[data-chat-composer-footer-compact]")
      ?.getAttribute("data-chat-composer-footer-compact"),
  ).toBe(layout === "compact" ? "true" : "false");
}

function focusTarget(): EventTarget {
  return document.activeElement ?? document.body;
}

function extrasRegion() {
  const controls = moreOptionsToggle()?.getAttribute("aria-controls");
  return controls ? document.getElementById(controls) : null;
}

async function pressOutside() {
  const outside = container.querySelector<HTMLElement>("[data-normal-composer]") ?? container;
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      outside.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, button: 0 }));
    }
  });
}

async function highlight(name: string) {
  for (let attempt = 0; attempt < rows().length + 1; attempt += 1) {
    if (highlightedRow()?.textContent?.includes(name)) return;
    await press(searchInput(), "ArrowDown");
  }
  expect(highlightedRow()?.textContent, `Expected ${name} to be highlighted`).toContain(name);
}

describe("combined picker guards", () => {
  it("combined picker guard: a model-row click still applies the model through ChatView", async () => {
    await mountApp();
    await openPicker();
    await click(row("GPT-5.5"));
    expect(pickerContent()).toBeNull();
    expect(draft()?.modelSelectionByProvider[CODEX]?.model).toBe("gpt-5.5");
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX]?.model).toBe(
      "gpt-5.5",
    );
    expect(draft()?.prompt).toBe("Keep this prompt");
  });

  it("combined picker guard: applying a model alone writes no access change", async () => {
    await mountApp();
    await openPicker();
    await click(row("GPT-5.5"));
    expect(draft()?.runtimeMode ?? null).toBeNull();
  });

  it("combined picker guard: search still filters the model list", async () => {
    await mountApp();
    await openPicker();
    await typeSearch("5.5");
    expect(rows().map((entry) => entry.textContent)).toEqual([expect.stringContaining("GPT-5.5")]);
  });

  it("combined picker guard: outside press closes the model picker", async () => {
    await mountApp();
    await openPicker();
    await pressOutside();
    expect(pickerContent()).toBeNull();
  });

  it.each(["expanded", "compact", "resting"] as const)(
    "combined picker guard: the model shortcut still opens the picker in the %s layout",
    async (layout) => {
      useComposerLayout(layout);
      await mountApp();
      expectComposerLayout(layout);
      await press(focusTarget(), "m", { altKey: true, code: "KeyM" });
      expect(pickerContent()).toBeTruthy();
    },
  );

  it.each(["expanded", "compact"] as const)(
    "combined picker guard: Chat and Plan stay reachable in the %s layout",
    async (layout) => {
      fixture.planModeEnabled = true;
      useComposerLayout(layout);
      await mountApp();
      expectComposerLayout(layout);
      if (layout === "expanded") {
        expect(buttonByLabel(/plan mode/i, container)).toBeTruthy();
        return;
      }
      await click(buttonByLabel("More composer controls", container)!);
      expect(
        [...document.querySelectorAll('[role="menuitemradio"]')].map((item) =>
          item.textContent?.trim(),
        ),
      ).toEqual(expect.arrayContaining(["Chat", "Plan"]));
    },
  );
});

describe("combined picker provider cycling", () => {
  it("combined picker Tab from search selects the next eligible provider instance", async () => {
    await mountApp();
    await openPicker();
    expect(selectedRailLabel()).toBe("Codex");

    await press(searchInput(), "Tab");
    expect(selectedRailLabel()).toBe("Claude");
    expect(document.activeElement).toBe(searchInput());
    expect(rows().map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Claude Opus 5"),
    ]);

    await press(searchInput(), "Tab");
    expect(selectedRailLabel()).toBe("Favorites");
    await press(searchInput(), "Tab", { shiftKey: true });
    expect(selectedRailLabel()).toBe("Claude");
  });

  it("combined picker Shift+Tab from search cycles providers instead of focusing the rail", async () => {
    await mountApp();
    await openPicker();

    await press(searchInput(), "Tab", { shiftKey: true });
    expect(selectedRailLabel()).toBe("Favorites");
    expect(document.activeElement).toBe(searchInput());
  });
});

describe("combined picker inline effort", () => {
  it("combined picker Right and Left change only the highlighted row's pending effort", async () => {
    await mountApp();
    await openPicker();
    const before = savedSnapshot();
    await highlight("GPT-5.4");
    expect(effortValue("GPT-5.4")).toBe("Medium");
    expect(effortValue("GPT-5.5")).toBe("High");

    await press(searchInput(), "ArrowRight");
    expect(effortValue("GPT-5.4")).toBe("High");
    expect(effortValue("GPT-5.5")).toBe("High");
    expect(highlightedRow()?.textContent).toContain("GPT-5.4");

    await press(searchInput(), "ArrowRight");
    await press(searchInput(), "ArrowRight");
    expect(effortValue("GPT-5.4")).toBe("Extra High");

    for (let count = 0; count < 5; count += 1) {
      await press(searchInput(), "ArrowLeft");
    }
    expect(effortValue("GPT-5.4")).toBe("Low");
    expect(pickerContent()).toBeTruthy();
    expect(savedSnapshot()).toEqual(before);
  });

  it("combined picker arrow keys edit effort even while the search has text", async () => {
    await mountApp();
    await openPicker();
    await typeSearch("gpt");
    await highlight("GPT-5.5");

    await press(searchInput(), "ArrowLeft");
    expect(effortValue("GPT-5.5")).toBe("Medium");
    expect(searchInput().value).toBe("gpt");
  });

  it("combined picker modified arrow keys leave the pending effort untouched", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.4");
    expect(effortValue("GPT-5.4")).toBe("Medium");

    await press(searchInput(), "ArrowRight", { shiftKey: true });
    await press(searchInput(), "ArrowRight", { altKey: true });
    await press(searchInput(), "ArrowLeft", { ctrlKey: true });
    await press(searchInput(), "ArrowRight", { isComposing: true });
    expect(effortValue("GPT-5.4")).toBe("Medium");
  });

  it("combined picker effort steppers adjust a row without selecting it", async () => {
    await mountApp();
    await openPicker();
    const before = savedSnapshot();

    const decrease = buttonByLabel("Decrease effort for GPT-5.5", pickerContent()!);
    expect(decrease, "Expected a labelled effort stepper").toBeTruthy();
    await click(decrease!);

    expect(effortValue("GPT-5.5")).toBe("Medium");
    expect(pickerContent()).toBeTruthy();
    expect(savedSnapshot()).toEqual(before);
    expect(buttonByLabel("Increase effort for GPT-5.5", pickerContent()!)).toBeTruthy();
  });

  it("combined picker keeps each row's pending effort while browsing one opening", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");
    await highlight("GPT-5.5");
    await press(searchInput(), "ArrowLeft");

    await press(searchInput(), "Tab");
    expect(selectedRailLabel()).toBe("Claude");
    await press(searchInput(), "Tab", { shiftKey: true });
    expect(selectedRailLabel()).toBe("Codex");

    expect(effortValue("GPT-5.4")).toBe("High");
    expect(effortValue("GPT-5.5")).toBe("Medium");
  });
});

describe("combined picker apply", () => {
  it("combined picker Enter applies the highlighted model with its pending effort", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.5");
    await press(searchInput(), "ArrowLeft");
    expect(effortValue("GPT-5.5")).toBe("Medium");

    await press(searchInput(), "Enter");

    const applied = {
      instanceId: CODEX,
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "medium" }],
    };
    expect(pickerContent()).toBeNull();
    expect(draft()?.modelSelectionByProvider[CODEX]).toEqual(applied);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX]).toEqual(applied);
    expect(draft()?.prompt).toBe("Keep this prompt");
    expect(draft()?.runtimeMode ?? null).toBeNull();
  });

  it("combined picker row click applies the pending effort of that row", async () => {
    await mountApp();
    await openPicker();
    await press(searchInput(), "Tab");
    await highlight("Claude Opus 5");
    await press(searchInput(), "ArrowRight");
    expect(effortValue("Claude Opus 5")).toBe("High");

    await click(row("Claude Opus 5"));

    expect(pickerContent()).toBeNull();
    expect(draft()?.activeProvider).toBe(CLAUDE);
    expect(draft()?.modelSelectionByProvider[CLAUDE]).toEqual({
      instanceId: CLAUDE,
      model: "claude-opus-5",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("combined picker stages Ultrathink and prefixes the prompt current at apply time", async () => {
    await mountApp();
    await openPicker();
    await press(searchInput(), "Tab");
    await highlight("Claude Opus 5");
    for (let count = 0; count < 3; count += 1) {
      await press(searchInput(), "ArrowRight");
    }
    expect(effortValue("Claude Opus 5")).toBe("Ultrathink");
    expect(draft()?.prompt).toBe("Keep this prompt");

    await act(async () => {
      useComposerDraftStore.getState().setPrompt(threadRef, "Keep this prompt, then more");
    });
    await press(searchInput(), "Enter");

    expect(draft()?.modelSelectionByProvider[CLAUDE]?.model).toBe("claude-opus-5");
    expect(draft()?.prompt).toBe("Ultrathink:\nKeep this prompt, then more");
  });

  it("combined picker rejected selection leaves model, options, prompt, and access unchanged", async () => {
    fixture.environments[0]!.serverConfig.providers = [
      { ...fixture.codexProvider, requiresNewThreadForModelChange: true },
      { ...fixture.claudeProvider },
    ];
    fixture.thread = {
      ...makeThread("approval-required"),
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: CODEX,
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    };
    await mountApp();
    const before = savedSnapshot();
    await openPicker();
    await openMoreOptions();
    await chooseOption("Access level", "Full access");

    await click(row("GPT-5.5"));
    expect(savedSnapshot()).toEqual(before);
    await press(focusTarget(), "Escape");
    expect(savedSnapshot()).toEqual(before);
  });
});

describe("combined picker cancellation", () => {
  it("combined picker Escape discards pending effort, options, and access", async () => {
    await mountApp();
    const before = savedSnapshot();
    await openPicker();
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");
    await openMoreOptions();
    await chooseOption("Service tier", "Fast");
    await chooseOption("Access level", "Full access");
    expect(accessSummary()).toContain("Full access");

    await press(focusTarget(), "Escape");

    expect(pickerContent()).toBeNull();
    expect(savedSnapshot()).toEqual(before);
    await openPicker();
    expect(effortValue("GPT-5.4")).toBe("Medium");
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(accessSummary()).toContain("Supervised");
  });

  it("combined picker outside dismissal discards pending changes", async () => {
    await mountApp();
    const before = savedSnapshot();
    await openPicker();
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");
    expect(effortValue("GPT-5.4")).toBe("High");

    await pressOutside();

    expect(pickerContent()).toBeNull();
    expect(savedSnapshot()).toEqual(before);
    await openPicker();
    expect(effortValue("GPT-5.4")).toBe("Medium");
  });
});

describe("combined picker More options", () => {
  it("combined picker has one More options row that edits extras and access without applying", async () => {
    await mountApp();
    const before = savedSnapshot();
    await openPicker();
    await highlight("GPT-5.4");

    const toggles = [...pickerContent()!.querySelectorAll("button")].filter((button) =>
      (button.textContent?.trim() ?? "").startsWith("More options"),
    );
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(accessSummary()).toContain("Supervised");
    expect(pickerContent()!.querySelector('[aria-label="Access level"]')).toBeNull();

    await click(toggles[0]!);
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("true");
    await chooseOption("Service tier", "Fast");
    await chooseOption("Access level", "Full access");

    expect(pickerContent()).toBeTruthy();
    expect(savedSnapshot()).toEqual(before);
    expect(accessSummary()).toContain("Full access");
  });

  it("combined picker Use model applies effort, provider options, and access together", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");
    await openMoreOptions();
    await chooseOption("Service tier", "Fast");
    await chooseOption("Access level", "Full access");

    const use = buttonByLabel(/^Use\b/, extrasRegion() ?? pickerContent()!);
    expect(use, "Expected a Use model button in More options").toBeTruthy();
    await click(use!);

    expect(pickerContent()).toBeNull();
    expect(draft()?.modelSelectionByProvider[CODEX]?.model).toBe("gpt-5.4");
    expect(draft()?.modelSelectionByProvider[CODEX]?.options).toEqual(
      expect.arrayContaining([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ]),
    );
    expect(draft()?.runtimeMode).toBe("full-access");
    expect(draft()?.prompt).toBe("Keep this prompt");
  });

  it("combined picker More options keeps access usable when a model has no extra controls", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.5");
    await openMoreOptions();

    expect(pickerContent()!.querySelector('[aria-label="Service tier"]')).toBeNull();
    await chooseOption("Access level", "Auto");
    expect(accessSummary()).toContain("Auto");
  });

  it("combined picker keys inside More options do not cycle providers or change effort", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.4");
    await openMoreOptions();
    const access = pickerContent()!.querySelector<HTMLElement>('[aria-label="Access level"]');
    expect(access).toBeTruthy();

    await press(access!, "Tab");
    await press(access!, "ArrowRight");
    expect(selectedRailLabel()).toBe("Codex");
    expect(effortValue("GPT-5.4")).toBe("Medium");
  });
});

describe("combined picker access summary", () => {
  it("combined picker access summary shows the thread's saved access", async () => {
    await mountApp();
    await openPicker();
    expect(accessSummary()).toContain("Supervised");
  });

  it("combined picker access summary shows Full access for a full-access thread", async () => {
    fixture.thread = makeThread("full-access");
    await mountApp();
    await openPicker();
    expect(accessSummary()).toContain("Full access");
  });

  it("combined picker access summary prefers the composer's explicit access", async () => {
    useComposerDraftStore.getState().setRuntimeMode(threadRef, "auto");
    await mountApp();
    await openPicker();
    expect(accessSummary()).toContain("Auto");
    expect(accessSummary()).not.toContain("Supervised");
  });
});

describe("combined picker shortcuts in every composer layout", () => {
  it.each(["expanded", "compact", "resting"] as const)(
    "combined picker traits shortcut opens the picker with More options expanded in the %s layout",
    async (layout) => {
      useComposerLayout(layout);
      await mountApp();
      expectComposerLayout(layout);

      await press(focusTarget(), "e", { altKey: true, code: "KeyE" });

      expect(pickerContent()).toBeTruthy();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(extrasRegion()?.contains(document.activeElement)).toBe(true);

      await press(focusTarget(), "e", { altKey: true, code: "KeyE" });
      expect(pickerContent()).toBeTruthy();
      expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(searchInput());
    },
  );

  it.each(["expanded", "compact", "resting"] as const)(
    "combined picker composer.effort alias opens the expanded picker in the %s layout",
    async (layout) => {
      useComposerLayout(layout);
      await mountApp();
      expectComposerLayout(layout);

      await press(focusTarget(), "Y", { altKey: true, shiftKey: true, code: "KeyY" });

      expect(pickerContent()).toBeTruthy();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("true");
    },
  );

  it.each(["expanded", "compact", "resting"] as const)(
    "combined picker composer.mode alias opens the picker without opening access in the %s layout",
    async (layout) => {
      useComposerLayout(layout);
      await mountApp();
      expectComposerLayout(layout);

      await press(focusTarget(), "A", { ctrlKey: true, shiftKey: true, code: "KeyA" });

      expect(pickerContent()).toBeTruthy();
      // No separate access Select may open: the only listbox is the picker's own.
      expect(
        [...document.querySelectorAll('[role="listbox"]')].filter(
          (listbox) => !listbox.closest("[data-model-picker-content]"),
        ),
      ).toEqual([]);
      expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");
    },
  );

  it.each(["expanded", "compact", "resting"] as const)(
    "combined picker leaves no separate effort or access control in the %s layout",
    async (layout) => {
      useComposerLayout(layout);
      await mountApp();
      expectComposerLayout(layout);

      expect(container.querySelector('[aria-label="Runtime mode"]')).toBeNull();
      const separateEffortButton = [...container.querySelectorAll("button")].find(
        (button) =>
          !button.closest('[data-chat-provider-model-picker="true"]') &&
          button.textContent?.trim() === "Medium",
      );
      expect(separateEffortButton).toBeUndefined();
      const overflow = buttonByLabel("More composer controls", container);
      if (overflow && !overflow.closest("[inert]")) {
        await click(overflow);
        const items = [...document.querySelectorAll('[role="menuitemradio"]')].map((item) =>
          item.textContent?.trim(),
        );
        expect(items).not.toContain("Full access");
        expect(items).not.toContain("Supervised");
        expect(items).not.toContain("Medium");
      }
    },
  );
});

describe("combined picker rework regressions", () => {
  it("combined picker More options drops a model the search no longer shows", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.4");
    await openMoreOptions();
    expect(extrasRegion()?.textContent).toContain("GPT-5.4");

    await typeSearch("5.5");
    expect(extrasRegion()?.textContent ?? "").not.toContain("GPT-5.4");
    expect(buttonByLabel("Use GPT-5.4", pickerContent()!)).toBeNull();

    await highlight("GPT-5.5");
    expect(buttonByLabel("Use GPT-5.5", extrasRegion()!)).toBeTruthy();
  });

  it("combined picker More options drops a model the provider rail no longer shows", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.5");
    await openMoreOptions();

    await press(searchInput(), "Tab");
    expect(selectedRailLabel()).toBe("Claude");
    expect(extrasRegion()?.textContent ?? "").not.toContain("GPT-5.5");
    expect(buttonByLabel("Use GPT-5.5", pickerContent()!)).toBeNull();

    await highlight("Claude Opus 5");
    expect(buttonByLabel("Use Claude Opus 5", extrasRegion()!)).toBeTruthy();
  });

  it("combined picker apply boundary rejects a staged effort the newer prompt pins", async () => {
    // The prompt changes after the effort was staged, as dictation can do. The
    // picker still hands the choice to ChatView, which must reject it before
    // writing the model, options, sticky choice, prompt, or access.
    useComposerDraftStore.getState().setPrompt(threadRef, "Ultrathink:\nKeep this prompt");
    await mountApp();
    await openPicker();
    await press(searchInput(), "Tab");
    await highlight("Claude Opus 5");
    expect(effortValue("Claude Opus 5")).toBe("Ultrathink");
    await press(searchInput(), "ArrowLeft");
    expect(effortValue("Claude Opus 5")).toBe("Max");
    await openMoreOptions();
    await chooseOption("Access level", "Full access");

    const pinnedPrompt = "Ultrathink:\nPlease ultrathink the newly added text";
    await act(async () => {
      useComposerDraftStore.getState().setPrompt(threadRef, pinnedPrompt);
    });
    const before = savedSnapshot();
    await click(buttonByLabel("Use Claude Opus 5", extrasRegion()!)!);

    expect(pickerContent()).toBeNull();
    expect(savedSnapshot()).toEqual(before);
    expect(draft()?.prompt).toBe(pinnedPrompt);
    expect(draft()?.modelSelectionByProvider[CLAUDE]).toBeUndefined();
    expect(draft()?.runtimeMode ?? null).toBeNull();
  });

  it("combined picker keeps options a choice cleared when returning to the earlier model", async () => {
    fixture.thread = {
      ...makeThread("approval-required"),
      modelSelection: {
        instanceId: CODEX,
        model: "gpt-5.4",
        options: [{ id: "serviceTier", value: "priority" }],
      },
    };
    await mountApp();
    await openPicker();
    await highlight("GPT-5.5");
    await press(searchInput(), "Enter");
    expect(draft()?.modelSelectionByProvider[CODEX]?.model).toBe("gpt-5.5");
    expect(draft()?.modelSelectionByProvider[CODEX]?.options ?? []).not.toContainEqual({
      id: "serviceTier",
      value: "priority",
    });

    await openPicker();
    await highlight("GPT-5.4");
    await openMoreOptions();
    const serviceTier = pickerContent()!.querySelector<HTMLSelectElement>(
      '[aria-label="Service tier"]',
    );
    expect(serviceTier?.value).toBe("default");
    await click(buttonByLabel("Use GPT-5.4", extrasRegion()!)!);

    expect(draft()?.modelSelectionByProvider[CODEX]?.model).toBe("gpt-5.4");
    expect(draft()?.modelSelectionByProvider[CODEX]?.options ?? []).not.toContainEqual({
      id: "serviceTier",
      value: "priority",
    });
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX]?.options ?? [],
    ).not.toContainEqual({ id: "serviceTier", value: "priority" });
  });
});

/** Publishes a new provider catalog, as a server config update does. */
async function publishProviders(providers: unknown[]) {
  await act(async () => {
    fixture.environments = [
      { ...baseEnvironment, serverConfig: { ...baseEnvironment.serverConfig, providers } },
    ];
    fixture.thread = fixture.thread ? { ...fixture.thread } : null;
    for (const listener of fixture.threadListeners) listener();
  });
}

/** Stages GPT-5.5 at Medium with Full access and holds the real picker's candidate. */
async function holdStagedGpt55Candidate() {
  await openPicker();
  await highlight("GPT-5.5");
  await press(searchInput(), "ArrowLeft");
  await openMoreOptions();
  await chooseOption("Access level", "Full access");
  fixture.holdApply = true;
  await click(buttonByLabel("Use GPT-5.5", extrasRegion()!)!);
  fixture.holdApply = false;
  const candidate = fixture.heldCandidate;
  expect(candidate?.modelSelection).toEqual({
    instanceId: CODEX,
    model: "gpt-5.5",
    options: [{ id: "reasoningEffort", value: "medium" }],
  });
  expect(candidate?.runtimeMode).toBe("full-access");
  return candidate!;
}

async function deliverToChatView(candidate: CombinedPickerCandidate) {
  let accepted: boolean | null = null;
  await act(async () => {
    accepted = fixture.applySelection!(candidate);
  });
  return accepted;
}

function seedFreshDraft() {
  fixture.thread = null;
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("combined-picker-project"));
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
      threadId: draftThreadId,
      createdAt: now,
    });
}

describe("combined picker regression coverage", () => {
  it("combined picker apply boundary rejects a held candidate whose model the catalog dropped", async () => {
    // The real picker staged a complete choice, then the server dropped the
    // model before the choice reached ChatView. ChatView must reject it rather
    // than substitute Codex's default model, and write nothing.
    await mountApp();
    const candidate = await holdStagedGpt55Candidate();
    const before = savedSnapshot();
    await publishProviders([
      {
        ...fixture.codexProvider,
        models: fixture.codexProvider.models.filter(
          (model) => (model as { slug: string }).slug !== "gpt-5.5",
        ),
      },
      { ...fixture.claudeProvider },
    ]);

    expect(await deliverToChatView(candidate)).toBe(false);

    expect(savedSnapshot()).toEqual(before);
    expect(draft()?.modelSelectionByProvider[CODEX]).toBeUndefined();
    expect(draft()?.runtimeMode ?? null).toBeNull();
    expect(draft()?.prompt).toBe("Keep this prompt");
  });

  it("combined picker apply boundary accepts the same held candidate while the catalog offers it", async () => {
    // Control for the test above: the held candidate is valid, so only the
    // catalog change can be what rejects it there.
    await mountApp();
    const candidate = await holdStagedGpt55Candidate();

    expect(await deliverToChatView(candidate)).toBe(true);

    expect(draft()?.modelSelectionByProvider[CODEX]).toEqual(candidate.modelSelection);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX]).toEqual(
      candidate.modelSelection,
    );
    expect(draft()?.runtimeMode).toBe("full-access");
  });

  it("guard: combined picker shows Full access for a fresh draft without an explicit default", async () => {
    seedFreshDraft();
    await mountApp("draft");
    await openPicker();
    expect(accessSummary()).toContain("Full access");
  });

  it("guard: combined picker shows a fresh draft's explicit access default", async () => {
    fixture.defaultRuntimeMode = "approval-required";
    seedFreshDraft();
    await mountApp("draft");
    await openPicker();
    expect(accessSummary()).toContain("Supervised");
    expect(accessSummary()).not.toContain("Full access");
  });
});
