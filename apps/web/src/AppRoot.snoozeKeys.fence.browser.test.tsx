// Phase 2 fence entry point: AppRoot through renderFenceApp, with the real Sidebar,
// KeyEngineHost, CommandPalette, and CustomSnoozeDialogHost. Only environment I/O is replaced.
// The shared AppRoot factories replace environment I/O, not the sidebar or section components.
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, type Screen } from "../test/render";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

const sidebarFixture = vi.hoisted(() => ({
  threads: [] as EnvironmentThreadShell[],
  projects: [] as unknown[],
  listeners: new Set<() => void>(),
  grouped: false,
  update: async (_ref: ScopedThreadRef, _until: string | null): Promise<void> => {},
  calls: [] as { ref: ScopedThreadRef; until: string | null }[],
}));
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);
vi.mock("./state/entities", async (original) =>
  (await fenceMocks()).mockSidebarEntities(original, sidebarFixture),
);
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/queries", async (original) => (await fenceMocks()).mockQueries(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", async () => (await fenceMocks()).mockAtomCommand());
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
vi.mock("./state/server", async (original) => {
  const mocks = await fenceMocks();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const [environment] = mocks.appRootFence.environments;
  const { serverConfig } = environment!;
  // Snooze and both reorders on, so every shelf and drag the sidebar offers is live.
  const capabilities = {
    ...serverConfig.environment.capabilities,
    threadSnooze: true,
    threadPinReorder: true,
    threadActiveReorder: true,
  };
  const configs = new Map([
    [
      environment!.environmentId,
      {
        ...serverConfig,
        environment: { ...serverConfig.environment, capabilities },
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          snoozePresets: [
            { kind: "after" as const, minutes: 240 },
            { kind: "after" as const, minutes: 15 },
            { kind: "after" as const, minutes: 90 },
            { kind: "after" as const, minutes: 30 },
            { kind: "after" as const, minutes: 120 },
            { kind: "after" as const, minutes: 45 },
            { kind: "after" as const, minutes: 180 },
            { kind: "after" as const, minutes: 60 },
          ],
        },
      },
    ],
  ]);
  const actual = await mocks.mockServer(original);
  return {
    ...actual,
    environmentServerConfigsAtom: Atom.make(configs),
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: Atom.family((id: import("@t3tools/contracts").EnvironmentId) =>
        Atom.make(configs.get(id)?.settings ?? DEFAULT_SERVER_SETTINGS),
      ),
    },
  };
});
vi.mock("./hooks/useSettings", async (original) => ({
  ...(await (await fenceMocks()).mockSettings(original)),
  useBoringSidebarEnabled: () => sidebarFixture.grouped,
}));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => {
  const actions = (await fenceMocks()).mockThreadActions();
  return {
    ...actions,
    useThreadActions: () => ({
      ...actions.useThreadActions(),
      snoozeThread: async (ref: ScopedThreadRef, until: string) => {
        await sidebarFixture.update(ref, until);
        return { _tag: "Success" as const, value: undefined };
      },
      unsnoozeThread: async (ref: import("@t3tools/contracts").ScopedThreadRef) => {
        await sidebarFixture.update(ref, null);
        return { _tag: "Success" as const, value: undefined };
      },
    }),
  };
});
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

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { openCommandPalette } from "./commandPaletteBus";
import { resolveSnoozePresets } from "./components/Sidebar.snooze";
import { WORKING_SECTION_EXPANDED_KEY } from "./components/sidebar/workingSection";
import { SNOOZED_SECTION_EXPANDED_KEY as SNOOZED_KEY } from "./components/sidebar/SidebarSnoozedSection";
import { toastManager } from "./components/ui/toast";
import { installKeyEngine } from "./keys/keyEngine";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { useProjectScopeStore } from "./projectScopeStore";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
  type FenceRouter,
} from "./test/appRootFenceApp";
import { appRootFence as fixture } from "./test/appRootFenceMocks";
import { makeFenceThreadShell } from "./test/fenceThreadShell";

const NOW = "2026-11-02T12:00:00.000Z";
const UNTIL = "2099-01-01T13:00:00.000Z";
const OPEN = "snooze-keys-open";
const OTHER = "snooze-keys-other";
const SNOOZED = "snooze-keys-sleeping";

function ref(id: string) {
  return scopeThreadRef(environmentId, ThreadId.make(id));
}
function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-mesura-thread-key="${scopedThreadKey(ref(id))}"]`,
  );
  expect(element, `sidebar row for ${id}`).not.toBeNull();
  return element!;
}
function header(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-sidebar-row="shelf:snoozed"]');
  expect(element, "Snoozed header").not.toBeNull();
  return element!;
}
function clock(): Disposable {
  vi.setSystemTime(new Date(NOW));
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}
async function leader(suffix: string) {
  await userEvent.keyboard(` ${suffix}`);
}
async function chatFocus() {
  await act(async () => (document.activeElement as HTMLElement | null)?.blur());
  await userEvent.keyboard("{Escape}");
}
function popup() {
  // The accessible popup name is part of this fence's UI contract. Its row role is not fixed.
  return page.getByRole("dialog", { name: /snooze/i });
}
async function openPopup() {
  await leader("zz");
  await vi.waitFor(() => expect(popup().element()).toBeTruthy());
  await expect.element(popup()).toBeVisible();
}
async function choosePalette(title: string) {
  await act(async () => openCommandPalette({ query: title }));
  await expect
    .element(page.getByPlaceholder("Search commands, projects, and threads..."))
    .toBeVisible();
  await vi.waitFor(() => expect(page.getByText(title, { exact: true }).element()).toBeTruthy());
  await userEvent.click(page.getByText(title, { exact: true }));
}
async function expectCall(id: string, until: string | null) {
  await vi.waitFor(() => expect(sidebarFixture.calls).toEqual([{ ref: ref(id), until }]));
}

async function setup(
  options: {
    vimMode?: boolean;
    snoozed?: boolean;
    blocked?: boolean;
    noTarget?: boolean;
    expanded?: boolean;
  } = {},
) {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  window.localStorage.clear();
  window.localStorage.setItem(SNOOZED_KEY, JSON.stringify(options.expanded ?? false));
  window.localStorage.setItem(WORKING_SECTION_EXPANDED_KEY, "false");
  useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
  fixture.threads.clear();
  fixture.threadStates.clear();
  fixture.clientSettings = { sidebarWorkingShelfEnabled: true, timestampFormat: "12-hour" };
  sidebarFixture.grouped = false;
  sidebarFixture.calls = [];
  installKeyEngine();
  addFenceThread(
    OPEN,
    "Open snooze target",
    [makeMessage("snooze-keys-message", "assistant", "Done.")],
    {
      overrides: {
        ...(options.snoozed
          ? { snoozedAt: DateTime.makeUnsafe(NOW), snoozedUntil: DateTime.makeUnsafe(UNTIL) }
          : {}),
        ...(options.blocked
          ? {
              pendingRuntimeRequest: {
                id: RuntimeRequestId.make("snooze-keys-request"),
                kind: "user_input" as const,
                createdAt: DateTime.makeUnsafe(NOW),
              },
            }
          : {}),
      },
    },
  );
  addFenceThread(OTHER, "Focused snooze target", []);
  addFenceThread(SNOOZED, "Already sleeping", [], {
    overrides: { snoozedAt: DateTime.makeUnsafe(NOW), snoozedUntil: DateTime.makeUnsafe(UNTIL) },
  });
  if (options.noTarget) {
    fixture.threads.delete(OPEN);
    fixture.threadStates.delete(OPEN);
  }
  sidebarFixture.threads = [...fixture.threads.values()];
  sidebarFixture.projects = [fixture.project];
  sidebarFixture.update = async (target, until) => {
    sidebarFixture.calls.push({ ref: target, until });
    const previous = fixture.threads.get(target.threadId)!;
    fixture.threads.set(
      target.threadId,
      makeFenceThreadShell({
        id: previous.id,
        environmentId: target.environmentId,
        projectId: ProjectId.make(previous.projectId),
        overrides: {
          ...previous.source,
          snoozedAt: until ? DateTime.makeUnsafe(NOW) : null,
          snoozedUntil: until ? DateTime.makeUnsafe(until) : null,
        },
      }),
    );
    sidebarFixture.threads = [...fixture.threads.values()];
    for (const listener of fixture.threadListeners) listener();
    for (const listener of sidebarFixture.listeners) listener();
  };
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100dvh";
  let router: FenceRouter | null = null;
  return {
    pathname: () => router?.state.location.pathname,
    presets: () => resolveSnoozePresets(new Date(NOW), "12-hour", environmentId),
    async render(): Promise<Screen> {
      const rendered = await renderFenceApp(container, ThreadId.make(OPEN), {
        vimMode: options.vimMode ?? true,
      });
      router = rendered.router;
      return rendered.root;
    },
    async [Symbol.asyncDispose]() {
      container.remove();
      fixture.threads.clear();
      fixture.threadStates.clear();
      fixture.clientSettings = {};
      sidebarFixture.threads = [];
      sidebarFixture.projects = [];
      sidebarFixture.calls = [];
      useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
      window.localStorage.clear();
      await page.viewport(viewport.width, viewport.height);
    },
  };
}

describe("Snooze keyboard phase 2 fence", () => {
  it("snooze keys phase 2 P2-1 in-flight: a popup pick cannot duplicate a pending row snooze", async () => {
    using _clock = clock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = sidebarFixture.update;
    using mutation = vi
      .spyOn(sidebarFixture, "update")
      .mockImplementation(async (target, until) => {
        await pending;
        await update(target, until);
      });
    try {
      const target = row(OTHER).closest("[data-thread-item]")!;
      await userEvent.hover(target);
      await userEvent.click(
        page.elementLocator(target).getByRole("button", { name: "Snooze thread", exact: true }),
      );
      const first = state.presets()[0]!;
      await userEvent.click(
        page.getByRole("menuitem", { name: `${first.label} ${first.whenLabel}`, exact: true }),
      );
      expect(mutation).toHaveBeenCalledTimes(1);
      await act(async () => row(OTHER).focus());
      await openPopup();
      await userEvent.keyboard("1");
      expect(mutation).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await expectCall(OTHER, state.presets()[0]!.snoozedUntil);
    }
  });

  it.each(["row", "popup"] as const)(
    "snooze keys phase 2 P2-1 navigation: %s pick on the open thread advances to the next eligible thread",
    async (source) => {
      using _clock = clock();
      await using state = await setup();
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      if (source === "popup") {
        await chatFocus();
        await openPopup();
        await userEvent.keyboard("1");
      } else {
        const target = row(OPEN).closest("[data-thread-item]")!;
        await userEvent.hover(target);
        await userEvent.click(
          page.elementLocator(target).getByRole("button", { name: "Snooze thread", exact: true }),
        );
        const first = state.presets()[0]!;
        await userEvent.click(
          page.getByRole("menuitem", { name: `${first.label} ${first.whenLabel}`, exact: true }),
        );
      }
      await expectCall(OPEN, state.presets()[0]!.snoozedUntil);
      await vi.waitFor(() => expect(state.pathname()).toBe(`/${environmentId}/${OTHER}`));
    },
  );

  it.each(["leader", "palette"] as const)(
    "snooze keys phase 2 P2-2 reveal: %s keeps an expanded Snoozed entry open when focus starts in chat",
    async (source) => {
      using _clock = clock();
      await using state = await setup({ expanded: true });
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await chatFocus();
      if (source === "leader") await leader("zs");
      else await choosePalette("Show snoozed threads");
      await vi.waitFor(() => {
        expect(header().getAttribute("aria-expanded")).toBe("true");
        expect(document.activeElement).toBe(header());
      });
    },
  );

  it("snooze keys phase 2 AC1: Space z shows the snooze group and its three labelled rows", async () => {
    using _clock = clock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await chatFocus();
    await leader("z");
    await vi.waitFor(() => expect(readKeyEngineSnapshot().whichKey?.title).toBe("snooze"));
    await expect.element(page.getByRole("status", { name: "Keys after snooze" })).toBeVisible();
    expect(
      readKeyEngineSnapshot().whichKey?.rows.map(({ token, label }) => [token, label]),
    ).toEqual([
      ["s", "Snoozed section"],
      ["u", "Wake thread"],
      ["z", "Snooze…"],
    ]);
    await userEvent.keyboard("{Escape}");
  });

  it.each([false, true])(
    "snooze keys phase 2 AC2: popup preserves environment preset order and hints (snoozed=%s)",
    async (snoozed) => {
      using _clock = clock();
      await using state = await setup({ snoozed });
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await chatFocus();
      await openPopup();
      const presets = state.presets();
      expect(presets).toHaveLength(8);
      const element = popup().element();
      const text = element.textContent!;
      let previousIndex = -1;
      for (const [index, preset] of presets.entries()) {
        const label = popup().getByText(preset.label, { exact: true });
        await expect.element(label).toBeVisible();
        expect(text.indexOf(preset.label)).toBeGreaterThan(previousIndex);
        previousIndex = text.indexOf(preset.label);
        await expect.element(popup().getByText(preset.whenLabel, { exact: true })).toBeVisible();
        await expect.element(popup().getByText(String(index + 1), { exact: true })).toBeVisible();
      }
      await expect.element(popup().getByText("Custom…", { exact: true })).toBeVisible();
      await expect.element(popup().getByText("c", { exact: true })).toBeVisible();
      expect(text.indexOf("Custom…")).toBeGreaterThan(previousIndex);
      if (snoozed) {
        expect(text.indexOf("Wake now")).toBeLessThan(text.indexOf(presets[0]!.label));
        await expect.element(popup().getByText("w", { exact: true })).toBeVisible();
      } else expect(text).not.toContain("Wake now");
      await userEvent.keyboard("{Escape}");
    },
  );

  it("snooze keys phase 2 AC3 Escape: closes without mutation and restores the invoking focus", async () => {
    using _clock = clock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await act(async () => row(OTHER).focus());
    const originalFocus = document.activeElement;
    await openPopup();
    await userEvent.keyboard("j{ArrowDown}k{ArrowUp}{Escape}");
    await expect.element(popup()).not.toBeInTheDocument();
    expect(sidebarFixture.calls).toEqual([]);
    await vi.waitFor(() => expect(document.activeElement).toBe(originalFocus));
  });

  it.each([
    { keys: "j", index: 1 },
    { keys: "{ArrowDown}", index: 1 },
    { keys: "jjk", index: 1 },
    { keys: "jj{ArrowUp}", index: 1 },
  ])(
    "snooze keys phase 2 AC3 navigation: $keys highlights the row Enter picks",
    async ({ keys, index }) => {
      using _clock = clock();
      await using state = await setup();
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await act(async () => row(OTHER).focus());
      await openPopup();
      await userEvent.keyboard(`${keys}{Enter}`);
      await expectCall(OTHER, state.presets()[index]!.snoozedUntil);
      await expect.element(popup()).not.toBeInTheDocument();
    },
  );

  it.each(["1", "8"])(
    "snooze keys phase 2 AC4 preset: hint %s uses the row action and moves the target into Snoozed",
    async (hint) => {
      using _clock = clock();
      await using state = await setup({ expanded: true });
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await chatFocus();
      await openPopup();
      await userEvent.keyboard(hint);
      await expectCall(OPEN, state.presets()[Number(hint) - 1]!.snoozedUntil);
      await vi.waitFor(() => expect(header().closest("li")?.contains(row(OPEN))).toBe(true));
    },
  );

  it("snooze keys phase 2 AC4 custom: c opens the existing dialog and submits its chosen instant", async () => {
    using _clock = clock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await chatFocus();
    await openPopup();
    await userEvent.keyboard("c");
    const dialog = page.getByRole("dialog", { name: "Custom snooze" });
    await expect.element(dialog).toBeVisible();
    await userEvent.click(dialog.getByText("Duration", { exact: true }));
    // The existing custom dialog defaults to two hours in Duration mode.
    await userEvent.click(dialog.getByRole("button", { name: "Snooze", exact: true }));
    await expectCall(OPEN, "2026-11-02T14:00:00.000Z");
  });

  it("snooze keys phase 2 AC4 wake: w unsnoozes an already snoozed popup target", async () => {
    using _clock = clock();
    await using state = await setup({ snoozed: true });
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await chatFocus();
    await openPopup();
    await userEvent.keyboard("w");
    await expectCall(OPEN, null);
    await vi.waitFor(() => expect(fixture.threads.get(OPEN)?.snoozedUntil).toBeNull());
  });

  it("snooze keys phase 2 AC5 focus: a focused sidebar row overrides the open thread", async () => {
    using _clock = clock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await act(async () => row(OTHER).focus());
    await openPopup();
    await userEvent.keyboard("1");
    await expectCall(OTHER, state.presets()[0]!.snoozedUntil);
    expect(fixture.threads.get(OPEN)?.snoozedUntil ?? null).toBeNull();
  });

  it.each(["missing", "blocked"] as const)(
    "snooze keys phase 2 AC5 rejection: %s target gives a reason without opening a popup",
    async (reason) => {
      using _clock = clock();
      await using state = await setup({
        noTarget: reason === "missing",
        blocked: reason === "blocked",
      });
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      if (reason === "blocked")
        expect(canSnooze(fixture.threads.get(OPEN)!, { now: NOW })).toBe(false);
      await chatFocus();
      using toast = vi.spyOn(toastManager, "add");
      await leader("zz");
      await vi.waitFor(() => {
        const content = toast.mock.calls
          .map(([entry]) => `${entry.title} ${entry.description ?? ""}`)
          .join(" ");
        expect(content).toMatch(
          reason === "missing"
            ? /no.*thread|select.*thread|open.*thread/i
            : /waiting|pending|respond/i,
        );
      });
      await expect.element(popup()).not.toBeInTheDocument();
      expect(sidebarFixture.calls).toEqual([]);
    },
  );

  it.each([false, true])(
    "snooze keys phase 2 AC6 wake leader: wakes only snoozed targets (snoozed=%s)",
    async (snoozed) => {
      using _clock = clock();
      await using state = await setup({ snoozed });
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await chatFocus();
      using toast = vi.spyOn(toastManager, "add");
      await leader("zu");
      if (snoozed) await expectCall(OPEN, null);
      else {
        await vi.waitFor(() =>
          expect(
            toast.mock.calls
              .map(([entry]) => `${entry.title} ${entry.description ?? ""}`)
              .join(" "),
          ).toMatch(/not snoozed|already awake/i),
        );
        expect(sidebarFixture.calls).toEqual([]);
      }
    },
  );

  it("snooze keys phase 2 AC6 section leader: expands and focuses the Snoozed header then collapses it", async () => {
    using _clock = clock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await chatFocus();
    expect(header().getAttribute("aria-expanded")).toBe("false");
    await leader("zs");
    await vi.waitFor(() => expect(header().getAttribute("aria-expanded")).toBe("true"));
    expect(document.activeElement).toBe(header());
    await leader("zs");
    await vi.waitFor(() => expect(header().getAttribute("aria-expanded")).toBe("false"));
    expect(window.localStorage.getItem(SNOOZED_KEY)).toBe("false");
  });

  it.each([
    { vimMode: false, title: "Snooze thread…" },
    { vimMode: false, title: "Wake thread" },
    { vimMode: false, title: "Show snoozed threads" },
    { vimMode: true, title: "Snooze thread…" },
    { vimMode: true, title: "Wake thread" },
    { vimMode: true, title: "Show snoozed threads" },
  ])(
    "snooze keys phase 2 AC7 palette: $title runs with vimMode=$vimMode",
    async ({ vimMode, title }) => {
      using _clock = clock();
      await using state = await setup({ vimMode, snoozed: title === "Wake thread" });
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await choosePalette(title);
      if (title === "Snooze thread…") {
        await vi.waitFor(() => expect(popup().element()).toBeTruthy());
        await expect.element(popup()).toBeVisible();
        await userEvent.keyboard("1");
        await expectCall(OPEN, state.presets()[0]!.snoozedUntil);
      } else if (title === "Wake thread") await expectCall(OPEN, null);
      else {
        await vi.waitFor(() => expect(header().getAttribute("aria-expanded")).toBe("true"));
        await vi.waitFor(() => expect(document.activeElement).toBe(header()));
      }
    },
  );

  it.each(["Snooze thread…", "Wake thread", "Show snoozed threads"])(
    "snooze keys phase 2 phone palette: %s works with the drawer closed and vimMode off",
    async (title) => {
      using _clock = clock();
      await using state = await setup({ vimMode: false, snoozed: true });
      await page.viewport(412, 915);
      await using screen = await state.render();
      await expect
        .element(screen.getByRole("button", { name: "Toggle main sidebar", exact: true }))
        .toBeVisible();
      await choosePalette(title);
      if (title === "Snooze thread…") {
        await vi.waitFor(() => expect(popup().element()).toBeTruthy());
        await userEvent.click(popup().getByText(state.presets()[0]!.label, { exact: true }));
        await expectCall(OPEN, state.presets()[0]!.snoozedUntil);
        await vi.waitFor(() => expect(state.pathname()).toBe(`/${environmentId}/${OTHER}`));
      } else if (title === "Wake thread") await expectCall(OPEN, null);
      else {
        await vi.waitFor(() => expect(header().getAttribute("aria-expanded")).toBe("true"));
        await vi.waitFor(() => expect(document.activeElement).toBe(header()));
      }
    },
  );

  it("snooze keys phase 2 guard row action: the existing Snooze button resolves environment presets and snoozes", async () => {
    using _clock = clock();
    await using state = await setup({ expanded: true });
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    const target = row(OTHER).closest("[data-thread-item]")!;
    await userEvent.hover(target);
    await userEvent.click(
      page.elementLocator(target).getByRole("button", { name: "Snooze thread", exact: true }),
    );
    const first = state.presets()[0]!;
    expect(state.presets()).toHaveLength(8);
    await userEvent.click(
      page.getByRole("menuitem", { name: `${first.label} ${first.whenLabel}`, exact: true }),
    );
    await expectCall(OTHER, first.snoozedUntil);
    await vi.waitFor(() => expect(header().closest("li")?.contains(row(OTHER))).toBe(true));
  });

  it("snooze keys phase 2 guard leader: the existing thread group and Space tw still toggle Working", async () => {
    using _clock = clock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await chatFocus();
    await leader("t");
    await expect.element(page.getByRole("status", { name: "Keys after thread" })).toBeVisible();
    expect(readKeyEngineSnapshot().whichKey?.rows).toContainEqual(
      expect.objectContaining({
        token: "w",
        label: "Working section",
        command: "sidebar.toggleWorking",
      }),
    );
    await userEvent.keyboard("w");
    await vi.waitFor(() =>
      expect(window.localStorage.getItem(WORKING_SECTION_EXPANDED_KEY)).toBe("true"),
    );
    await leader("tw");
    await vi.waitFor(() =>
      expect(window.localStorage.getItem(WORKING_SECTION_EXPANDED_KEY)).toBe("false"),
    );
  });
});
