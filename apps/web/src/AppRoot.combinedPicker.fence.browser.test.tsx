import { freshTestId } from "./test/freshTestId";
// The combined picker's behavior contract in the composer, through AppRoot and the real
// ChatComposer, ProviderModelPicker and ModelPickerContent, with docked effort and permissions.
// Choices apply immediately and are read back from the real composer draft store. Boundaries: only
// `test/appRootFenceMocks.tsx`.
import { type ReactNode } from "react";
import { act } from "../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
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
  buttonByLabel,
  click,
  effortColumn,
  effortLevel,
  highlightedRow,
  permissionsTrigger,
  pickerContent,
  pickerPopup,
  press,
  row,
  rows,
  searchInput,
  selectedEffort,
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

async function mountApp(
  runtimeMode: RuntimeMode = "approval-required",
  draftRuntimeMode?: RuntimeMode,
  providerLocked = false,
) {
  await using stack = new AsyncDisposableStack();
  installKeyEngine();
  await import("./components/files/FilePreviewPanel");

  const serverConfig = fixture.environments[0]!.serverConfig as { providers: unknown[] };
  const originalProviders = serverConfig.providers;
  const originalVimMode = fixture.vimMode;
  const originalClientSettings = fixture.clientSettings;
  const originalOpenThreadId = fixture.openThreadId;
  const originalDraftState = useComposerDraftStore.getState();
  const threadId = ThreadId.make(`combined-picker-${freshTestId("picker")}`);
  const threadRef = scopeThreadRef(environmentId, threadId);
  stack.defer(() => {
    fixture.threads.delete(threadId);
    fixture.threadStates.delete(threadId);
    fixture.openThreadId = originalOpenThreadId;
    fixture.vimMode = originalVimMode;
    fixture.clientSettings = originalClientSettings;
    serverConfig.providers = originalProviders;
    useComposerDraftStore.setState(originalDraftState, true);
  });
  serverConfig.providers = CATALOG;
  fixture.vimMode = false;
  fixture.clientSettings = { ...originalClientSettings, effortDisplay: "label" };
  // Each test starts without another test's remembered model choices.
  useComposerDraftStore.setState({
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  const previousRunId = RunId.make(`previous-${threadId}`);
  const shell = makeFenceThreadShell({
    environmentId,
    id: threadId,
    projectId: ProjectId.make(FENCE_PROJECT_ID),
    title: "Combined picker",
    runtimeMode,
    createdAt: NOW,
    ...(providerLocked ? { overrides: { latestRunId: previousRunId, itemCount: 1 } } : {}),
  });
  publishFenceThreadProjection(
    makeFenceThreadProjection(shell, {
      // A completed run without a portable provider thread cannot hand off to another provider.
      runs: providerLocked
        ? [
            {
              id: previousRunId,
              threadId,
              ordinal: 1,
              providerInstanceId: CODEX,
              modelSelection: shell.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`previous-message-${threadId}`),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: shell.source.createdAt,
              startedAt: shell.source.createdAt,
              completedAt: shell.source.updatedAt,
              checkpointId: null,
              contextHandoffId: null,
            },
          ]
        : [],
    }),
  );
  useComposerDraftStore.getState().setPrompt(threadRef, "Keep this prompt");
  if (draftRuntimeMode !== undefined) {
    useComposerDraftStore.getState().setRuntimeMode(threadRef, draftRuntimeMode);
  }
  const container = document.createElement("div");
  const { root } = await renderFenceApp(container, threadId, { vimMode: false });
  stack.use(root);
  await vi.waitFor(() => {
    expect(modelTrigger().disabled).toBe(false);
    expect(container.querySelector('[data-testid="composer-editor"]')?.textContent).toContain(
      "Keep this prompt",
    );
  });

  function draft() {
    return useComposerDraftStore.getState().getComposerDraft(threadRef);
  }

  /** Opening, browsing, and dismissing must not write a choice or alter sticky state. */
  function savedSnapshot() {
    const current = draft();
    return {
      modelSelectionByProvider: current?.modelSelectionByProvider ?? {},
      activeProvider: current?.activeProvider ?? null,
      runtimeMode: current?.runtimeMode ?? null,
      prompt: current?.prompt ?? "",
      modelSelectionExplicit: current?.modelSelectionExplicit ?? false,
      stickyActiveProvider: useComposerDraftStore.getState().stickyActiveProvider,
      stickyModelSelectionByProvider:
        useComposerDraftStore.getState().stickyModelSelectionByProvider,
      stickyOptionsByModelByProvider:
        useComposerDraftStore.getState().stickyOptionsByModelByProvider,
    };
  }

  function modelTrigger() {
    const trigger = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
    ].find((element) => !element.closest("[inert]"));
    expect(trigger, "Expected a visible composer model trigger").toBeTruthy();
    return trigger!;
  }

  async function openPicker() {
    await click(modelTrigger());
    await vi.waitFor(() => {
      expect(pickerContent(), "Expected the model picker to open").toBeTruthy();
      expect(document.activeElement).toBe(searchInput());
    });
  }

  async function pressOutside() {
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        container.dispatchEvent(
          new EventType(type, { bubbles: true, cancelable: true, button: 0 }),
        );
      }
    });
    await vi.waitFor(() => expect(pickerContent()).toBeNull());
  }

  const lifetime = stack.move();
  return {
    container,
    threadRef,
    draft,
    savedSnapshot,
    modelTrigger,
    openPicker,
    pressOutside,
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
  };
}

function modelTriggerLabel() {
  return (
    [
      ...document.querySelectorAll<HTMLElement>('[data-chat-provider-model-picker-label="true"]'),
    ].find((element) => !element.closest("[inert]"))?.textContent ?? null
  );
}

function selectedProviderTab() {
  return (
    pickerContent()
      ?.querySelector<HTMLElement>('[data-model-picker-sidebar] button[aria-pressed="true"]')
      ?.getAttribute("aria-label") ?? null
  );
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

function focusTarget(): EventTarget {
  return document.activeElement ?? document.body;
}

async function closePicker() {
  await press(focusTarget(), "Escape");
  await vi.waitFor(() => expect(pickerContent()).toBeNull());
}

async function chooseProvider(label: string) {
  const sidebar = pickerContent()!.querySelector<HTMLElement>("[data-model-picker-sidebar]")!;
  const button = buttonByLabel(label, sidebar);
  expect(button, `Expected provider ${label}`).toBeTruthy();
  await click(button!);
  await vi.waitFor(() => expect(selectedProviderTab()).toBe(label));
}

async function choosePermission(label: string) {
  await click(permissionsTrigger());
  await userEvent.click(page.getByRole("menuitemradio", { name: label, exact: true }));
  await expect
    .element(page.getByRole("menuitemradio", { name: label, exact: true }))
    .not.toBeInTheDocument();
}

describe("combined picker in the composer: provider navigation", () => {
  it("cycles providers with upstream shortcuts without applying a model", async () => {
    await using app = await mountApp();
    const before = app.savedSnapshot();
    await app.openPicker();
    expect(selectedProviderTab()).toBe("Codex");

    await press(searchInput(), "ArrowDown", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(selectedProviderTab()).toBe("Claude"));
    expect(document.activeElement).toBe(searchInput());
    expect(rows().map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Claude Opus 5"),
    ]);
    // Browsing a provider leaves the column on the model actually selected in the composer.
    expect(effortColumn().textContent).toContain("GPT-5.4");
    expect(app.savedSnapshot()).toEqual(before);

    await press(searchInput(), "ArrowUp", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(selectedProviderTab()).toBe("Codex"));
  });

  it("keeps the upstream sidebar navigation instead of editing effort with Left", async () => {
    await using app = await mountApp();
    await app.openPicker();
    const before = app.savedSnapshot();

    await press(searchInput(), "ArrowLeft");
    const selectedProvider = pickerContent()!.querySelector(
      '[data-model-picker-sidebar] button[aria-pressed="true"]',
    );
    expect(document.activeElement).toBe(selectedProvider);
    await press(selectedProvider!, "ArrowRight");
    expect(document.activeElement).toBe(searchInput());
    expect(selectedEffort()).toBe("Medium");
    expect(app.savedSnapshot()).toEqual(before);
  });

  it("locks other providers when the thread cannot hand off its completed run", async () => {
    await using app = await mountApp("approval-required", undefined, true);
    await app.openPicker();
    const before = app.savedSnapshot();
    const claude = buttonByLabel(/^Claude is unavailable in this thread/, pickerContent()!);
    expect(claude).toBeTruthy();
    expect(claude!.disabled).toBe(true);
    await click(claude!);
    expect(selectedProviderTab()).toBe("Codex");

    await typeSearch("Claude");
    expect(rows()).toHaveLength(0);
    expect(app.savedSnapshot()).toEqual(before);
  });
});

describe("combined picker in the composer: immediate selection", () => {
  it("Enter applies a highlighted model and focuses its reasoning without closing", async () => {
    await using app = await mountApp();
    await app.openPicker();
    await highlight("GPT-5.5");
    await press(searchInput(), "Enter");

    await vi.waitFor(() => {
      expect(app.draft()?.modelSelectionByProvider[CODEX]).toEqual({
        instanceId: CODEX,
        model: "gpt-5.5",
      });
      expect(document.activeElement).toBe(effortLevel("High"));
    });
    expect(pickerContent()).toBeTruthy();
    expect(effortColumn().textContent).toContain("GPT-5.5");
    expect(selectedEffort()).toBe("High");
    expect(app.draft()?.prompt).toBe("Keep this prompt");
    expect(app.draft()?.runtimeMode ?? null).toBeNull();
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX]?.model).toBe(
      "gpt-5.5",
    );

    const applied = app.savedSnapshot();
    await closePicker();
    expect(app.savedSnapshot()).toEqual(applied);
  });

  it("row clicks switch provider immediately and preserve the draft prompt and permissions", async () => {
    await using app = await mountApp();
    await app.openPicker();
    await chooseProvider("Claude");
    await click(row("Claude Opus 5"));

    await vi.waitFor(() => {
      expect(app.draft()?.activeProvider).toBe(CLAUDE);
      expect(app.draft()?.modelSelectionByProvider[CLAUDE]?.model).toBe("claude-opus-5");
      expect(document.activeElement).toBe(effortLevel("Medium"));
    });
    expect(pickerContent()).toBeTruthy();
    expect(modelTriggerLabel()).toBe("Opus 5");
    expect(app.draft()?.prompt).toBe("Keep this prompt");
    expect(app.draft()?.runtimeMode ?? null).toBeNull();
  });

  it("Right applies the highlighted model before entering its effort column", async () => {
    await using app = await mountApp();
    await app.openPicker();
    await highlight("GPT-5.5");
    await press(searchInput(), "ArrowRight");

    await vi.waitFor(() => {
      expect(app.draft()?.modelSelectionByProvider[CODEX]?.model).toBe("gpt-5.5");
      expect(document.activeElement).toBe(effortLevel("High"));
    });
    expect(selectedEffort()).toBe("High");
    await press(focusTarget(), "ArrowLeft");
    expect(document.activeElement).toBe(searchInput());
  });
});

describe("combined picker in the composer: docked effort and speed", () => {
  it("pointer picks persist effort and speed immediately without replacing the model or prompt", async () => {
    await using app = await mountApp();
    await app.openPicker();
    await click(effortLevel("High"));
    const fast = buttonByLabel("Fast", pickerPopup());
    expect(fast).toBeTruthy();
    await click(fast!);

    const options = [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ];
    expect(app.draft()?.modelSelectionByProvider[CODEX]).toEqual({
      instanceId: CODEX,
      model: "gpt-5.4",
      options,
    });
    expect(
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[CODEX]?.["gpt-5.4"],
    ).toEqual(options);
    expect(selectedEffort()).toBe("High");
    expect(app.draft()?.prompt).toBe("Keep this prompt");
    expect(app.draft()?.runtimeMode ?? null).toBeNull();
    const applied = app.savedSnapshot();
    await closePicker();
    expect(app.savedSnapshot()).toEqual(applied);
    await app.openPicker();
    expect(selectedEffort()).toBe("High");
    expect(buttonByLabel("Fast", pickerPopup())?.getAttribute("aria-checked")).toBe("true");
  });

  it("Up and Down move focus without writes, and Enter applies the focused effort", async () => {
    await using app = await mountApp();
    await app.openPicker();
    const before = app.savedSnapshot();
    await act(async () => effortLevel("Medium").focus());
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(effortLevel("High"));
    expect(selectedEffort()).toBe("Medium");
    expect(app.savedSnapshot()).toEqual(before);

    await userEvent.keyboard("{Enter}");
    expect(selectedEffort()).toBe("High");
    expect(app.draft()?.modelSelectionByProvider[CODEX]?.options).toEqual(
      expect.arrayContaining([{ id: "reasoningEffort", value: "high" }]),
    );
    expect(pickerContent()).toBeTruthy();
    await press(focusTarget(), "ArrowLeft");
    expect(document.activeElement).toBe(searchInput());
  });

  it("restores each model's sticky effort instead of carrying the previous model's options", async () => {
    await using app = await mountApp();
    await app.openPicker();
    await click(effortLevel("Low"));
    await click(row("GPT-5.5"));
    await vi.waitFor(() => expect(effortColumn().textContent).toContain("GPT-5.5"));
    expect(selectedEffort()).toBe("High");
    expect(app.draft()?.modelSelectionByProvider[CODEX]?.options).toBeUndefined();

    await click(effortLevel("Medium"));
    await click(row("GPT-5.4"));
    expect(selectedEffort()).toBe("Low");
    expect(app.draft()?.modelSelectionByProvider[CODEX]?.options).toEqual(
      expect.arrayContaining([{ id: "reasoningEffort", value: "low" }]),
    );
    await click(row("GPT-5.5"));
    expect(selectedEffort()).toBe("Medium");
    expect(
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[CODEX]?.["gpt-5.5"],
    ).toEqual([{ id: "reasoningEffort", value: "medium" }]);
  });

  it("offers Claude's real effort levels without injecting Ultrathink into the prompt", async () => {
    await using app = await mountApp();
    await app.openPicker();
    await chooseProvider("Claude");
    await click(row("Claude Opus 5"));
    await vi.waitFor(() => expect(effortColumn().textContent).toContain("Opus 5"));
    expect(effortColumn().textContent).not.toContain("Ultrathink");
    await click(effortLevel("Max"));

    expect(app.draft()?.modelSelectionByProvider[CLAUDE]?.options).toEqual([
      { id: "effort", value: "max" },
    ]);
    expect(
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[CLAUDE]?.["claude-opus-5"],
    ).toEqual([{ id: "effort", value: "max" }]);
    expect(app.draft()?.prompt).toBe("Keep this prompt");
  });
});

describe("combined picker in the composer: dismissal", () => {
  it("Escape after search and highlighting writes no draft, sticky option, or permission", async () => {
    await using app = await mountApp();
    const before = app.savedSnapshot();
    await app.openPicker();
    await typeSearch("5.5");
    await highlight("GPT-5.5");
    expect(selectedEffort()).toBe("Medium");
    await closePicker();
    expect(app.savedSnapshot()).toEqual(before);
    await app.openPicker();
    expect(searchInput().value).toBe("");
    expect(selectedEffort()).toBe("Medium");
  });

  it("outside press closes without applying the highlighted model", async () => {
    await using app = await mountApp();
    const before = app.savedSnapshot();
    await app.openPicker();
    await highlight("GPT-5.5");
    await app.pressOutside();
    expect(app.savedSnapshot()).toEqual(before);
  });
});

describe("combined picker in the composer: permissions", () => {
  it.each([
    ["approval-required", undefined, "Supervised"],
    ["full-access", undefined, "Full access"],
    ["approval-required", "auto", "Auto"],
  ] as const)("shows thread mode %s and draft override %s as %s", async (mode, override, label) => {
    await using app = await mountApp(mode, override);
    await app.openPicker();
    expect(permissionsTrigger().getAttribute("aria-label")).toBe(`Permissions: ${label}`);
  });

  it("applies footer permissions immediately and keeps the model and prompt unchanged", async () => {
    await using app = await mountApp();
    await app.openPicker();
    const before = app.savedSnapshot();
    await choosePermission("Full access");
    expect(app.draft()?.runtimeMode).toBe("full-access");
    expect(permissionsTrigger().getAttribute("aria-label")).toBe("Permissions: Full access");
    expect(app.savedSnapshot()).toEqual({ ...before, runtimeMode: "full-access" });
    expect(pickerContent()).toBeTruthy();
    await closePicker();
    expect(app.draft()?.runtimeMode).toBe("full-access");
  });

  it("Escape dismisses the permission menu without changing its checked mode", async () => {
    await using app = await mountApp();
    await app.openPicker();
    const before = app.savedSnapshot();
    await click(permissionsTrigger());
    await expect
      .element(page.getByRole("menuitemradio", { name: "Supervised", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("menuitemradio", { name: "Supervised", exact: true }))
      .not.toBeInTheDocument();
    expect(app.savedSnapshot()).toEqual(before);
    if (pickerContent()) await closePicker();
    expect(app.savedSnapshot()).toEqual(before);
  });
});

describe("combined picker in the composer: shortcuts", () => {
  it("Alt+E opens on the selected effort and returns there while the picker stays open", async () => {
    await using app = await mountApp();
    const before = app.savedSnapshot();
    await press(focusTarget(), "e", { altKey: true, code: "KeyE" });
    await vi.waitFor(() => expect(document.activeElement).toBe(effortLevel("Medium")));
    const popup = pickerPopup();
    await press(focusTarget(), "ArrowLeft");
    expect(document.activeElement).toBe(searchInput());
    await press(focusTarget(), "e", { altKey: true, code: "KeyE" });
    await vi.waitFor(() => expect(document.activeElement).toBe(effortLevel("Medium")));
    expect(pickerPopup()).toBe(popup);
    expect(app.savedSnapshot()).toEqual(before);
  });

  it("the permissions shortcut opens the default mode's menu without writing it", async () => {
    await using app = await mountApp("full-access");
    const before = app.savedSnapshot();
    await press(focusTarget(), "A", { ctrlKey: true, shiftKey: true, code: "KeyA" });
    await expect
      .element(page.getByRole("menuitemradio", { name: "Full access", exact: true }))
      .toHaveFocus();
    expect(pickerContent()).toBeTruthy();
    expect(app.savedSnapshot()).toEqual(before);
    await userEvent.keyboard("{ArrowLeft}{Enter}");
    expect(app.draft()?.runtimeMode).toBe("auto");
  });
});

// Mesura: the phone footer stacks the model row above the actions, both centered.
it("phone composer footer stacks the model row above the actions and drops the provider word", async () => {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(previousViewport.width, previousViewport.height),
  };
  await using app = await mountApp();
  await app.openPicker();
  await chooseProvider("Claude");
  await click(row("Claude Opus 5"));
  await closePicker();

  await page.viewport(412, 915);
  const editor = app.container.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  await act(async () => editor?.focus());
  await vi.waitFor(() => {
    const footer = app.container.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    expect(footer && getComputedStyle(footer).flexDirection).toBe("column");
    const controls = footer!.querySelector<HTMLElement>('[data-chat-composer-controls="footer"]');
    const actions = footer!.querySelector<HTMLElement>('[data-chat-composer-actions="right"]');
    expect(controls!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      actions!.getBoundingClientRect().top + 1,
    );
    expect(modelTriggerLabel()).toBe("Opus 5");
  });
});

it("keeps the phone footer and stacked picker controls usable within the viewport", async () => {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(previousViewport.width, previousViewport.height),
  };
  await page.viewport(412, 915);
  await using app = await mountApp();
  await app.openPicker();
  await chooseProvider("Claude");
  await click(row("Claude Opus 5"));
  await vi.waitFor(() => expect(document.activeElement).toBe(effortLevel("Medium")));
  await click(effortLevel("High"));
  await choosePermission("Full access");

  await vi.waitFor(() => {
    const models = pickerContent()!.getBoundingClientRect();
    const effort = effortColumn().getBoundingClientRect();
    const permissions = permissionsTrigger().getBoundingClientRect();
    expect(effort.top).toBeGreaterThanOrEqual(models.bottom - 1);
    expect(permissions.top).toBeGreaterThanOrEqual(effort.bottom - 1);
    expect(permissions.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(effort.left).toBeGreaterThanOrEqual(0);
    expect(effort.right).toBeLessThanOrEqual(window.innerWidth);
  });
  await closePicker();
  const editor = app.container.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  await act(async () => editor?.focus());
  await vi.waitFor(() => {
    const footer = app.container.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    expect(footer).toBeTruthy();
    expect(getComputedStyle(footer!).flexDirection).toBe("column");
    const trigger = app.modelTrigger().getBoundingClientRect();
    expect(trigger.width).toBeGreaterThan(0);
    expect(trigger.left).toBeGreaterThanOrEqual(0);
    expect(trigger.right).toBeLessThanOrEqual(window.innerWidth);
    expect(modelTriggerLabel()).toBe("Opus 5");
    expect(app.modelTrigger().getAttribute("aria-label")).toContain("High");
  });
  expect(app.draft()?.modelSelectionByProvider[CLAUDE]?.options).toEqual([
    { id: "effort", value: "high" },
  ]);
  expect(app.draft()?.runtimeMode).toBe("full-access");
  expect(app.draft()?.prompt).toBe("Keep this prompt");
});
