/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout, and whose chat layout is
 * the real `_chat.tsx` route component around the real ChatView. In it the
 * real ChatComposer renders the real ProviderModelPicker, CombinedModelPickerContent
 * and ModelPickerContent. Keys are real `keydown` events dispatched from the
 * focused element, and every write is read back from the real composer draft
 * store.
 *
 * The behavior contract of the combined picker in the composer:
 * - Tab and Shift+Tab cycle provider tabs from the search field.
 * - Left/Right change the highlighted model's pending effort, and the
 *   steppers do the same by pointer, without choosing the model.
 * - Enter or a row click applies that model with its pending effort.
 * - More options replaces the model screen; Back to models returns to the
 *   same search with every pending edit kept; Use applies effort, options and
 *   access together.
 * - Escape and a press outside discard every pending edit.
 * - The access shown is the thread's saved access until it is edited.
 * - The effort shortcut opens the picker on More options and toggles it while
 *   the picker is open; the access shortcut opens the picker.
 *
 * Boundaries the fixture replaces, and nothing else: the ones listed in
 * `test/appRootFenceMocks.tsx`. The providers are this file's catalog.
 */
import { type ReactNode } from "react";
import { act, type Screen } from "../test/render";
import { flushBrowserTasks } from "./test/browserTasks";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

// The boundaries the fixture replaces: see `test/appRootFenceMocks.tsx`.
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/queries", async (original) => (await fenceMocks()).mockQueries(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", async () => (await fenceMocks()).mockAtomCommand());
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
vi.mock("./state/server", async (original) => (await fenceMocks()).mockServer(original));
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => (await fenceMocks()).mockThreadActions());
vi.mock("./components/Sidebar", async () => (await fenceMocks()).mockSidebar());
vi.mock("./components/LegacySidebar", async () =>
  (await fenceMocks()).mockRendersNothing("default"),
);
vi.mock("./components/preview/PreviewAutomationHosts", async () =>
  (await fenceMocks()).mockRendersNothing("PreviewAutomationHosts"),
);
vi.mock("./browser/ElectronBrowserHost", async () =>
  (await fenceMocks()).mockRendersNothing("ElectronBrowserHost"),
);
vi.mock("./components/QuitHoldOverlay", async () =>
  (await fenceMocks()).mockRendersNothing("QuitHoldOverlay"),
);
vi.mock("./components/chat/ChatHeader", async () =>
  (await fenceMocks()).mockRendersNothing("ChatHeader"),
);
vi.mock("./components/BranchToolbar", async () =>
  (await fenceMocks()).mockRendersNothing("BranchToolbar"),
);
vi.mock("./components/files/mesuraFileManager/MesuraFileManagerLayer", async () =>
  (await fenceMocks()).mockFileManagerLayer(),
);
vi.mock("./keys/highlights", async () => (await fenceMocks()).mockHighlights());
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());
// The picker does not exercise diff workers. Keep that worker boundary outside this fixture.
vi.mock("./components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);

import { useComposerDraftStore } from "./composerDraftStore";
import { installKeyEngine } from "./keys/keyEngine";
import {
  accessSummary,
  buttonByLabel,
  click,
  effortValue,
  extrasRegion,
  highlightedRow,
  moreOptionsToggle,
  openMoreOptions,
  pickerContent,
  press,
  row,
  rows,
  searchInput,
} from "./test/combinedPickerDom";
import {
  fenceEnvironmentId as environmentId,
  publishFenceThreadProjection,
  renderFenceApp,
} from "./test/appRootFenceApp";
import { appRootFence as fixture, FENCE_PROJECT_ID } from "./test/appRootFenceMocks";
import { makeFenceThreadProjection, makeFenceThreadShell } from "./test/fenceThreadShell";

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const NOW = "2026-10-15T12:00:00.000Z";

const reasoning = (defaultId: string, ids: ReadonlyArray<[string, string]>) => ({
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select" as const,
  options: ids.map(([id, label]) => ({
    id,
    label,
    ...(id === defaultId ? { isDefault: true } : {}),
  })),
});

function provider(instanceId: string, driver: string, displayName: string, models: unknown[]) {
  return {
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models,
    slashCommands: [],
    skills: [],
  };
}

const CATALOG = [
  provider("codex", "codex", "Codex", [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          reasoning("medium", [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
          ]),
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
          reasoning("high", [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
          ]),
        ],
      },
    },
  ]),
  provider("claudeAgent", "claudeAgent", "Claude", [
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
  ]),
];

const serverConfig = fixture.environments[0]!.serverConfig as { providers: unknown[] };
const originalProviders = serverConfig.providers;
let threadSequence = 0;
let threadRef = scopeThreadRef(environmentId, ThreadId.make("combined-picker-unset"));
let root: Screen | undefined;
let container: HTMLDivElement;

// ChatView lazy-loads the file panel during the first mount. Compile it in setup,
// as the other AppRoot fences do, so a cold compile cannot time out the first spec.
beforeAll(async () => {
  installKeyEngine();
  serverConfig.providers = CATALOG;
  await import("./components/files/FilePreviewPanel");
}, 120_000);

afterAll(() => {
  serverConfig.providers = originalProviders;
});

/** Registers a thread on GPT-5.4 with the given saved access, and opens it. */
function seedThread(runtimeMode: RuntimeMode): ThreadId {
  threadSequence += 1;
  const threadId = ThreadId.make(`combined-picker-${threadSequence}`);
  const shell = makeFenceThreadShell({
    environmentId,
    id: threadId,
    projectId: ProjectId.make(FENCE_PROJECT_ID),
    title: "Combined picker",
    runtimeMode,
    createdAt: NOW,
  });
  publishFenceThreadProjection(makeFenceThreadProjection(shell));
  threadRef = scopeThreadRef(environmentId, threadId);
  useComposerDraftStore.getState().setPrompt(threadRef, "Keep this prompt");
  return threadId;
}

beforeEach(() => {
  fixture.vimMode = false;
  // Each test starts without another test's remembered model choices.
  useComposerDraftStore.setState({
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await root?.[Symbol.asyncDispose]();
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

async function mountApp(runtimeMode: RuntimeMode = "approval-required") {
  const threadId = seedThread(runtimeMode);
  ({ root } = await renderFenceApp(container, threadId, { vimMode: false }));
  await settle();
}

function draft() {
  return useComposerDraftStore.getState().getComposerDraft(threadRef);
}

/** Everything an applied choice may write; a cancelled opening must leave it equal. */
function savedSnapshot() {
  const current = draft();
  return {
    modelSelectionByProvider: current?.modelSelectionByProvider ?? {},
    activeProvider: current?.activeProvider ?? null,
    runtimeMode: current?.runtimeMode ?? null,
    prompt: current?.prompt ?? "",
  };
}

function modelTrigger() {
  const trigger = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
  ].find((element) => !element.closest("[inert]"));
  expect(trigger, "Expected a visible composer model trigger").toBeTruthy();
  return trigger!;
}

function selectedProviderTab() {
  return (
    pickerContent()
      ?.querySelector<HTMLElement>('[data-model-picker-sidebar] button[aria-pressed="true"]')
      ?.getAttribute("aria-label") ?? null
  );
}

async function openPicker() {
  await click(modelTrigger());
  await settle();
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

async function highlight(name: string) {
  for (let attempt = 0; attempt < rows().length + 1; attempt += 1) {
    if (highlightedRow()?.textContent?.includes(name)) return;
    await press(searchInput(), "ArrowDown");
  }
  expect(highlightedRow()?.textContent, `Expected ${name} to be highlighted`).toContain(name);
}

/** Chooses an option of a native select inside the picker. */
async function chooseOption(controlLabel: string, optionLabel: string) {
  const control = pickerContent()?.querySelector<HTMLSelectElement>(
    `select[aria-label="${controlLabel}"]`,
  );
  expect(control, `Expected the ${controlLabel} control`).toBeTruthy();
  const option = [...control!.options].find((entry) => entry.textContent?.trim() === optionLabel);
  expect(option, `Expected ${optionLabel} in ${controlLabel}`).toBeTruthy();
  await act(async () => {
    control!.value = option!.value;
    control!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function pressOutside() {
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      container.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, button: 0 }));
    }
  });
  await settle();
}

function focusTarget(): EventTarget {
  return document.activeElement ?? document.body;
}

describe("combined picker in the composer: provider tabs", () => {
  it("combined picker Tab and Shift+Tab cycle provider tabs and keep focus in search", async () => {
    await mountApp();
    await openPicker();
    expect(selectedProviderTab()).toBe("Codex");

    await press(searchInput(), "Tab");
    expect(selectedProviderTab()).toBe("Claude");
    expect(document.activeElement).toBe(searchInput());
    expect(rows().map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Claude Opus 5"),
    ]);

    await press(searchInput(), "Tab", { shiftKey: true });
    expect(selectedProviderTab()).toBe("Codex");
  });
});

describe("combined picker in the composer: inline effort", () => {
  it("combined picker Left and Right change only the highlighted row's pending effort", async () => {
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

    for (let count = 0; count < 5; count += 1) await press(searchInput(), "ArrowLeft");
    expect(effortValue("GPT-5.4")).toBe("Low");
    expect(pickerContent()).toBeTruthy();
    expect(savedSnapshot()).toEqual(before);
  });

  it("combined picker modified arrows keep their usual meaning", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.4");

    await press(searchInput(), "ArrowRight", { shiftKey: true });
    await press(searchInput(), "ArrowRight", { altKey: true });
    await press(searchInput(), "ArrowLeft", { ctrlKey: true });
    expect(effortValue("GPT-5.4")).toBe("Medium");
  });

  it("combined picker effort steppers change a row by pointer without choosing it", async () => {
    await mountApp();
    await openPicker();
    const before = savedSnapshot();

    await click(buttonByLabel("Decrease effort for GPT-5.5", pickerContent()!)!);

    expect(effortValue("GPT-5.5")).toBe("Medium");
    expect(pickerContent()).toBeTruthy();
    expect(savedSnapshot()).toEqual(before);
  });
});

describe("combined picker in the composer: apply", () => {
  it("combined picker Enter applies the highlighted model with its pending effort", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.5");
    await press(searchInput(), "ArrowLeft");

    await press(searchInput(), "Enter");
    await settle();

    expect(pickerContent()).toBeNull();
    expect(draft()?.modelSelectionByProvider[CODEX]).toEqual({
      instanceId: CODEX,
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    expect(
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[CODEX]?.["gpt-5.5"],
    ).toEqual([{ id: "reasoningEffort", value: "medium" }]);
    expect(draft()?.prompt).toBe("Keep this prompt");
    // Applying a model alone writes no access change.
    expect(draft()?.runtimeMode ?? null).toBeNull();
  });

  it("combined picker row click applies another provider's model with its effort", async () => {
    await mountApp();
    await openPicker();
    await press(searchInput(), "Tab");
    await highlight("Claude Opus 5");
    await press(searchInput(), "ArrowRight");

    await click(row("Claude Opus 5"));
    await settle();

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
    for (let count = 0; count < 3; count += 1) await press(searchInput(), "ArrowRight");
    expect(effortValue("Claude Opus 5")).toBe("Ultrathink");

    await act(async () => {
      useComposerDraftStore.getState().setPrompt(threadRef, "Keep this prompt, then more");
    });
    await press(searchInput(), "Enter");
    await settle();

    expect(draft()?.modelSelectionByProvider[CLAUDE]?.model).toBe("claude-opus-5");
    expect(draft()?.prompt).toBe("Ultrathink:\nKeep this prompt, then more");
  });

  it("guard: an unedited new model shows in the composer with the effort its row showed", async () => {
    await mountApp();
    await act(async () => {
      useComposerDraftStore
        .getState()
        .setProviderModelOptions(
          threadRef,
          ProviderDriverKind.make("codex"),
          [{ id: "reasoningEffort", value: "low" }],
          { instanceId: CODEX, model: "gpt-5.4" },
        );
    });
    await openPicker();
    expect(effortValue("GPT-5.4")).toBe("Low");
    expect(effortValue("GPT-5.5")).toBe("High");

    await click(row("GPT-5.5"));
    await settle();

    expect(draft()?.modelSelectionByProvider[CODEX]?.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
  });
});

describe("combined picker in the composer: cancellation", () => {
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
    await settle();

    expect(pickerContent()).toBeNull();
    expect(savedSnapshot()).toEqual(before);
    await openPicker();
    expect(effortValue("GPT-5.4")).toBe("Medium");
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(accessSummary()).toContain("Supervised");
  });

  it("combined picker outside press discards pending changes", async () => {
    await mountApp();
    const before = savedSnapshot();
    await openPicker();
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");

    await pressOutside();

    expect(pickerContent()).toBeNull();
    expect(savedSnapshot()).toEqual(before);
    await openPicker();
    expect(effortValue("GPT-5.4")).toBe("Medium");
  });
});

describe("combined picker in the composer: More options", () => {
  it("combined picker More options replaces search, and Back keeps the search and every pending edit", async () => {
    await mountApp();
    const before = savedSnapshot();
    await openPicker();
    await typeSearch("5.4");
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");
    await openMoreOptions();

    expect(searchInput().closest("[inert]")).toBeTruthy();
    expect(extrasRegion()?.textContent).toContain("GPT-5.4 · Codex");
    expect(extrasRegion()?.contains(document.activeElement)).toBe(true);
    await chooseOption("Service tier", "Fast");
    await chooseOption("Access level", "Full access");

    await click(moreOptionsToggle()!);
    await settle();
    expect(searchInput().closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(searchInput());
    expect(searchInput().value).toBe("5.4");
    expect(effortValue("GPT-5.4")).toBe("High");
    expect(savedSnapshot()).toEqual(before);

    await openMoreOptions();
    expect(
      extrasRegion()?.querySelector<HTMLSelectElement>('[aria-label="Service tier"]')?.value,
    ).toBe("priority");
    expect(
      extrasRegion()?.querySelector<HTMLSelectElement>('[aria-label="Access level"]')?.value,
    ).toBe("full-access");
  });

  it("combined picker Use applies effort, provider options, and access together", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.4");
    await press(searchInput(), "ArrowRight");
    await openMoreOptions();
    await chooseOption("Service tier", "Fast");
    await chooseOption("Access level", "Full access");

    await click(buttonByLabel("Use GPT-5.4", extrasRegion()!)!);
    await settle();

    expect(pickerContent()).toBeNull();
    expect(draft()?.modelSelectionByProvider[CODEX]?.options).toEqual(
      expect.arrayContaining([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ]),
    );
    expect(draft()?.runtimeMode).toBe("full-access");
    expect(draft()?.prompt).toBe("Keep this prompt");
  });

  it("combined picker More options targets the highlighted model, not the saved one", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.5");
    await openMoreOptions();

    expect(extrasRegion()?.textContent).toContain("GPT-5.5 · Codex");
    expect(extrasRegion()?.querySelector('[aria-label="Service tier"]')).toBeNull();
    await click(buttonByLabel("Use GPT-5.5", extrasRegion()!)!);
    await settle();
    expect(draft()?.modelSelectionByProvider[CODEX]?.model).toBe("gpt-5.5");
  });

  it("combined picker More options never targets a model the current tab hides", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.5");
    await press(searchInput(), "Tab");
    expect(highlightedRow()).toBeNull();

    await openMoreOptions();
    expect(extrasRegion()?.textContent).toContain("No model highlighted");
    expect(buttonByLabel(/^Use /, extrasRegion()!)).toBeNull();

    await click(moreOptionsToggle()!);
    await settle();
    await press(searchInput(), "ArrowDown");
    await openMoreOptions();
    expect(extrasRegion()?.textContent).toContain("Claude Opus 5 · Claude");
  });

  it("combined picker keys inside More options neither cycle providers nor change effort", async () => {
    await mountApp();
    await openPicker();
    await highlight("GPT-5.4");
    await openMoreOptions();
    const access = pickerContent()!.querySelector<HTMLElement>('[aria-label="Access level"]')!;

    await press(access, "Tab");
    await press(access, "ArrowRight");
    await click(moreOptionsToggle()!);
    await settle();

    expect(selectedProviderTab()).toBe("Codex");
    expect(effortValue("GPT-5.4")).toBe("Medium");
  });
});

describe("combined picker in the composer: access", () => {
  it("combined picker shows an existing thread's saved access", async () => {
    await mountApp("approval-required");
    await openPicker();
    expect(accessSummary()).toContain("Supervised");
  });

  it("combined picker shows Full access for a thread created with the default access", async () => {
    await mountApp("full-access");
    await openPicker();
    expect(accessSummary()).toContain("Full access");
  });

  it("combined picker prefers the composer's own access over the thread's", async () => {
    const threadId = seedThread("approval-required");
    useComposerDraftStore.getState().setRuntimeMode(threadRef, "auto");
    ({ root } = await renderFenceApp(container, threadId, { vimMode: false }));
    await settle();
    await openPicker();
    expect(accessSummary()).toContain("Auto");
  });
});

describe("combined picker in the composer: shortcuts", () => {
  it("combined picker effort shortcut opens on More options and toggles it while open", async () => {
    await mountApp();
    await press(focusTarget(), "e", { altKey: true, code: "KeyE" });
    await settle();

    expect(pickerContent()).toBeTruthy();
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(extrasRegion()?.textContent).toContain("GPT-5.4 · Codex");

    await press(focusTarget(), "e", { altKey: true, code: "KeyE" });
    await settle();
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(searchInput());
  });

  it("combined picker access shortcut opens the picker on model search", async () => {
    await mountApp();
    await press(focusTarget(), "A", { ctrlKey: true, shiftKey: true, code: "KeyA" });
    await settle();

    expect(pickerContent()).toBeTruthy();
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("guard: the composer shows no separate effort or access control", async () => {
    await mountApp();
    expect(container.querySelector('[aria-label="Runtime mode"]')).toBeNull();
    expect(container.querySelector('[data-composer-shortcut~="composer.effort"]')).toBeNull();
    // The trigger shows the saved effort after the model name.
    expect(
      modelTrigger().querySelector('[data-chat-provider-model-picker-traits="true"]')?.textContent,
    ).toBe("Medium");
  });
});
