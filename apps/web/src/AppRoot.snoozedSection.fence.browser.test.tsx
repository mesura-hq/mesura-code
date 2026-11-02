// Phase 1 fence: mounts AppRoot through renderFenceApp, with the real Sidebar and sidebar tree.
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
  wake: async (_ref: ScopedThreadRef): Promise<void> => {},
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
        settings: DEFAULT_SERVER_SETTINGS,
      },
    ],
  ]);
  return {
    ...(await mocks.mockServer(original)),
    environmentServerConfigsAtom: Atom.make(configs),
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
      unsnoozeThread: async (ref: import("@t3tools/contracts").ScopedThreadRef) => {
        await sidebarFixture.wake(ref);
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
import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { WORKING_SECTION_EXPANDED_KEY } from "./components/sidebar/workingSection";
import { THREAD_CONTEXT_DROP_EVENT } from "./components/chat/threadContextDrag";
import { installKeyEngine } from "./keys/keyEngine";
import { useProjectScopeStore } from "./projectScopeStore";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
} from "./test/appRootFenceApp";
import { appRootFence as fixture } from "./test/appRootFenceMocks";
import { makeFenceThreadShell } from "./test/fenceThreadShell";

const SNOOZED_KEY = "t3code:sidebar:snoozed-expanded";
const NOW = "2026-11-02T12:00:00.000Z";
const SOON = "2099-01-01T13:00:00.000Z";
const LATER = "2099-01-05T12:00:00.000Z";
const OPEN_UNTIL = "2099-01-09T12:00:00.000Z";
const OPEN = "snoozed-fence-open";
const SETTLED_ID = "snoozed-fence-settled";
const SOON_ID = "snoozed-fence-soon";
const LATER_ID = "snoozed-fence-later";

function fixedClock(): Disposable {
  vi.setSystemTime(new Date(NOW));
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}

function key(id: string): string {
  return scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
}

function shell(id: string, overrides: Partial<EnvironmentThreadShell["source"]> = {}) {
  return makeFenceThreadShell({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make(fixture.project.id),
    title: id,
    overrides: { updatedAt: DateTime.makeUnsafe(NOW), ...overrides },
  });
}

function snoozed(id: string, until: string) {
  return shell(id, {
    snoozedAt: DateTime.makeUnsafe(NOW),
    snoozedUntil: DateTime.makeUnsafe(until),
  });
}

function snoozedHeader(): HTMLElement {
  const row = document.querySelector<HTMLElement>('[data-sidebar-row="shelf:snoozed"]');
  expect(row, "the Snoozed treeitem").not.toBeNull();
  return row!;
}

function workingHeader(): HTMLElement {
  const row = document.querySelector<HTMLElement>('[data-sidebar-row="shelf:working"]');
  expect(row, "the Working treeitem").not.toBeNull();
  return row!;
}

function topSections(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="tree"] [data-sidebar-row]')];
}

function rowsWithinHeaderSection(): string[] {
  const item = snoozedHeader().closest("li");
  expect(item, "the Snoozed section list item").not.toBeNull();
  return [...item!.querySelectorAll<HTMLElement>("[data-thread-item]")].map(
    (row) => row.dataset.threadItem!,
  );
}

function upstreamShelf(): HTMLElement | null {
  return document.querySelector('[data-testid="sidebar-snoozed-header"]');
}

function search(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search threads"]')!;
}

async function press(key: string): Promise<void> {
  await userEvent.keyboard(key === " " ? " " : `{${key}}`);
}

async function tap(element: HTMLElement): Promise<void> {
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          pointerId: 1,
          isPrimary: true,
          button: 0,
          buttons: type === "pointerdown" ? 1 : 0,
        }),
      );
    }
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

async function expectSettledAtTreeBottom(): Promise<void> {
  await vi.waitFor(() => {
    const tree = document.querySelector<HTMLElement>('[role="tree"][aria-label="Threads"]')!;
    const settledRow = document.querySelector<HTMLElement>(
      `[data-thread-item="${key(SETTLED_ID)}"]`,
    );
    expect(settledRow).not.toBeNull();
    expect(
      Math.abs(tree.getBoundingClientRect().bottom - settledRow!.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(2);
  });
}

/** Seeds before mounting; the screen disposes before fixture state and the viewport reset. */
async function setup(
  options: {
    readonly expanded?: boolean;
    readonly openSnoozed?: boolean;
    readonly enabled?: boolean;
    readonly grouped?: boolean;
    readonly empty?: boolean;
    readonly phone?: boolean;
    readonly settled?: boolean;
  } = {},
) {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(options.phone ? 412 : 1440, options.phone ? 915 : 900);
  window.localStorage.clear();
  useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
  fixture.threads.clear();
  fixture.threadStates.clear();
  fixture.clientSettings = { sidebarWorkingShelfEnabled: options.enabled ?? true };
  sidebarFixture.grouped = options.grouped ?? false;
  installKeyEngine();
  if (options.expanded !== undefined)
    window.localStorage.setItem(SNOOZED_KEY, JSON.stringify(options.expanded));
  window.localStorage.setItem(WORKING_SECTION_EXPANDED_KEY, "false");
  addFenceThread(OPEN, "Open thread", [
    makeMessage("snoozed-fence-assistant", "assistant", "Done."),
  ]);
  if (options.openSnoozed) fixture.threads.set(OPEN, snoozed(OPEN, OPEN_UNTIL));
  const extras = options.empty ? [] : [snoozed(LATER_ID, LATER), snoozed(SOON_ID, SOON)];
  const at = DateTime.makeUnsafe(NOW);
  const runId = RunId.make("snoozed-fence-working-run");
  fixture.threads.set(
    "snoozed-fence-working",
    shell("snoozed-fence-working", {
      status: "running",
      latestRunId: runId,
      activeRunId: runId,
      latestRunRequestedAt: at,
      latestRunStartedAt: at,
      latestUserAuthoredMessageAt: at,
    }),
  );
  for (const thread of extras) fixture.threads.set(thread.id, thread);
  if (options.settled) {
    fixture.threads.set(
      SETTLED_ID,
      shell(SETTLED_ID, { settledOverride: "settled", settledAt: at }),
    );
    window.localStorage.setItem("t3code:sidebar:settled-expanded", "true");
  }
  sidebarFixture.threads = [...fixture.threads.values()];
  sidebarFixture.projects = [fixture.project];
  sidebarFixture.wake = async (ref) => {
    const previous = fixture.threads.get(ref.threadId)!;
    fixture.threads.set(
      ref.threadId,
      makeFenceThreadShell({
        id: previous.id,
        environmentId: previous.environmentId,
        projectId: previous.projectId,
        overrides: { ...previous.source, snoozedAt: null, snoozedUntil: null },
      }),
    );
    sidebarFixture.threads = [...fixture.threads.values()];
    for (const listener of fixture.threadListeners) listener();
    for (const listener of sidebarFixture.listeners) listener();
  };
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100dvh";
  return {
    async render(): Promise<Screen> {
      const { root } = await renderFenceApp(container, ThreadId.make(OPEN), { vimMode: false });
      // The mount helper owns the router and its shortcut registrations.
      return root;
    },
    async [Symbol.asyncDispose]() {
      container.remove();
      fixture.threads.clear();
      fixture.threadStates.clear();
      fixture.clientSettings = {};
      sidebarFixture.threads = [];
      sidebarFixture.projects = [];
      sidebarFixture.grouped = false;
      useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
      window.localStorage.clear();
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

describe("Snoozed above Working phase 1", () => {
  it("snoozed phase 1 AC1: the count and soonest wake sit directly above Working", async () => {
    using _clock = fixedClock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() =>
      expect(
        topSections()
          .slice(0, 2)
          .map((row) => row.dataset.sidebarRow),
      ).toEqual(["shelf:snoozed", "shelf:working"]),
    );
    expect(snoozedHeader().textContent).toContain("Snoozed");
    await expect
      .element(page.elementLocator(snoozedHeader()).getByText("2", { exact: true }))
      .toBeVisible();
    expect(snoozedHeader().textContent).toContain(snoozeWakeLabel(SOON, { now: NOW }));
  });

  it("snoozed phase 1 AC2: the moved shelf has no upstream marker and no duplicate rows", async () => {
    using _clock = fixedClock();
    await using state = await setup({ expanded: true, settled: true });
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() => expect(workingHeader()).toBeTruthy());
    expect(upstreamShelf()).toBeNull();
    expect(rowsWithinHeaderSection()).toEqual([key(SOON_ID), key(LATER_ID)]);
    for (const id of [SOON_ID, LATER_ID])
      expect(document.querySelectorAll(`[data-thread-item="${key(id)}"]`)).toHaveLength(1);
    await expectSettledAtTreeBottom();
  });

  it("snoozed phase 1 review P1-2: a reference drag reaches the composer without moving or waking the thread", async () => {
    using _clock = fixedClock();
    await using state = await setup({ expanded: true });
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    const source = document.querySelector<HTMLElement>(
      `[data-mesura-thread-key="${key(SOON_ID)}"]`,
    )!;
    const activeRow = document.querySelector<HTMLElement>(
      `[data-mesura-thread-key="${key(OPEN)}"]`,
    )!;
    await userEvent.dragAndDrop(source, activeRow);
    expect(fixture.threads.get(SOON_ID)?.snoozedUntil).toBe(SOON);
    expect(rowsWithinHeaderSection()).toEqual([key(SOON_ID), key(LATER_ID)]);

    const dropTarget = await vi.waitFor(() => {
      const target = document.querySelector<HTMLElement>("[data-thread-context-drop]");
      expect(target).not.toBeNull();
      return target!;
    });
    const dropped: ScopedThreadRef[] = [];
    const onDrop = (event: Event) =>
      dropped.push(...(event as CustomEvent<ScopedThreadRef[]>).detail);
    dropTarget.addEventListener(THREAD_CONTEXT_DROP_EVENT, onDrop);
    try {
      await userEvent.dragAndDrop(source, dropTarget);
      await vi.waitFor(() =>
        expect(dropped).toEqual([scopeThreadRef(environmentId, ThreadId.make(SOON_ID))]),
      );
    } finally {
      dropTarget.removeEventListener(THREAD_CONTEXT_DROP_EVENT, onDrop);
    }
    expect(fixture.threads.get(SOON_ID)?.snoozedUntil).toBe(SOON);
  });

  it("snoozed phase 1 AC3: collapsed keeps the open snoozed row, expansion orders wakes, and wake removes a row", async () => {
    using _clock = fixedClock();
    await using state = await setup({ openSnoozed: true });
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() => expect(snoozedHeader().getAttribute("aria-expanded")).toBe("false"));
    expect(
      topSections()
        .slice(0, 3)
        .map((row) => row.dataset.sidebarRow),
    ).toEqual(["shelf:snoozed", key(OPEN), "shelf:working"]);
    expect(rowsWithinHeaderSection()).toEqual([key(OPEN)]);
    await userEvent.click(snoozedHeader());
    await vi.waitFor(() =>
      expect(rowsWithinHeaderSection()).toEqual([key(SOON_ID), key(LATER_ID), key(OPEN)]),
    );
    for (const [id, until] of [
      [SOON_ID, SOON],
      [LATER_ID, LATER],
      [OPEN, OPEN_UNTIL],
    ]) {
      const row = document.querySelector<HTMLElement>(`[data-thread-item="${key(id!)}"]`)!;
      expect(row.textContent).toContain(snoozeWakeLabel(until!, { now: NOW }));
    }
    const firstRow = document.querySelector<HTMLElement>(`[data-thread-item="${key(SOON_ID)}"]`)!;
    await userEvent.hover(firstRow);
    await userEvent.click(firstRow.querySelector<HTMLElement>('[aria-label="Wake thread now"]')!);
    await vi.waitFor(() => expect(rowsWithinHeaderSection()).toEqual([key(LATER_ID), key(OPEN)]));
    expect(fixture.threads.get(SOON_ID)?.snoozedUntil).toBeNull();
  });

  it("snoozed phase 1 AC4: pointer toggles persist through an AppRoot remount", async () => {
    using _clock = fixedClock();
    await using state = await setup();
    {
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await vi.waitFor(() => expect(topSections()[0]).toBe(snoozedHeader()));
      await userEvent.click(snoozedHeader());
      await vi.waitFor(() => expect(snoozedHeader().getAttribute("aria-expanded")).toBe("true"));
      expect(window.localStorage.getItem(SNOOZED_KEY)).toBe("true");
    }
    {
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await vi.waitFor(() => expect(snoozedHeader().getAttribute("aria-expanded")).toBe("true"));
      expect(rowsWithinHeaderSection()).toHaveLength(2);
      await userEvent.click(snoozedHeader());
      await vi.waitFor(() => expect(snoozedHeader().getAttribute("aria-expanded")).toBe("false"));
      expect(window.localStorage.getItem(SNOOZED_KEY)).toBe("false");
    }
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() => expect(snoozedHeader().getAttribute("aria-expanded")).toBe("false"));
    expect(rowsWithinHeaderSection()).toEqual([]);
  });

  // AC5 is already true on the base. This remains a guard.
  it("snoozed phase 1 guard AC5: zero snoozed threads leaves Working first with no empty entry", async () => {
    using _clock = fixedClock();
    await using state = await setup({ empty: true });
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() => expect(topSections()[0]).toBe(workingHeader()));
    expect(document.querySelector('[data-sidebar-row="shelf:snoozed"]')).toBeNull();
    expect(upstreamShelf()).toBeNull();
    expect(workingHeader().getBoundingClientRect().height).toBe(32);
    const searchBox = search().getBoundingClientRect();
    const workingBox = workingHeader().getBoundingClientRect();
    expect(workingBox.top - searchBox.bottom).toBeLessThan(32);
  });

  it("snoozed phase 1 AC6: Search arrows follow Snoozed then Working and Enter or Space toggle", async () => {
    using _clock = fixedClock();
    await using state = await setup();
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() => expect(search()).not.toBeNull());
    await act(async () => search().focus());
    await press("ArrowDown");
    expect(document.activeElement).toBe(snoozedHeader());
    expect(snoozedHeader().getAttribute("role")).toBe("treeitem");
    await press("ArrowDown");
    expect(document.activeElement).toBe(workingHeader());
    await press("ArrowUp");
    expect(document.activeElement).toBe(snoozedHeader());
    await press("Enter");
    await vi.waitFor(() => expect(snoozedHeader().getAttribute("aria-expanded")).toBe("true"));
    await press(" ");
    await vi.waitFor(() => expect(snoozedHeader().getAttribute("aria-expanded")).toBe("false"));
    await press("ArrowUp");
    expect(document.activeElement).toBe(search());
  });

  it("snoozed phase 1 AC7: Pixel 7 has a single line without overflow and taps toggle", async () => {
    using _clock = fixedClock();
    await using state = await setup({ phone: true, settled: true });
    await using screen = await state.render();
    await expect.element(screen.getByRole("region", { name: "Conversation" })).toBeVisible();
    await userEvent.keyboard("{Control>}b{/Control}");
    // The phone drawer renders in a portal outside the AppRoot container.
    await expect.element(page.getByRole("tree", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() =>
      expect(snoozedHeader().getBoundingClientRect().width).toBeGreaterThan(200),
    );
    expect(topSections()[0]).toBe(snoozedHeader());
    await expect
      .element(page.elementLocator(snoozedHeader()).getByText("2", { exact: true }))
      .toBeVisible();
    const row = snoozedHeader();
    // The drawer translates during entry; assert its bounds through the browser wait contract.
    await vi.waitFor(() => {
      const box = row.getBoundingClientRect();
      expect(box.height).toBe(32);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(412);
    });
    expect(row.textContent).toContain(snoozeWakeLabel(SOON, { now: NOW }));
    await expectSettledAtTreeBottom();
    await tap(row);
    await vi.waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("true"));
    expect(rowsWithinHeaderSection()).toHaveLength(2);
    await tap(row);
    await vi.waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("false"));
  });

  it.each([
    { mode: "Working disabled", enabled: false, grouped: false },
    { mode: "project folders", enabled: true, grouped: true },
  ])(
    "snoozed phase 1 guard fallback: $mode keeps upstream collapse, open row, order, and wake",
    async ({ enabled, grouped }) => {
      using _clock = fixedClock();
      await using state = await setup({ enabled, grouped, openSnoozed: true });
      await using screen = await state.render();
      await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
      await vi.waitFor(() => expect(upstreamShelf()).not.toBeNull());
      if (grouped) expect(document.querySelector('[data-sidebar-row^="folder:"]')).not.toBeNull();
      expect(document.querySelector('[data-sidebar-row="shelf:working"]')).toBeNull();
      expect(document.querySelectorAll('[data-sidebar-row="shelf:snoozed"]')).toHaveLength(1);
      expect(upstreamShelf()!.querySelector('[data-sidebar-row="shelf:snoozed"]')).toBe(
        snoozedHeader(),
      );
      expect(document.querySelector(`[data-thread-item="${key(OPEN)}"]`)).not.toBeNull();
      expect(document.querySelector(`[data-thread-item="${key(SOON_ID)}"]`)).toBeNull();
      await userEvent.click(snoozedHeader());
      await vi.waitFor(() =>
        expect(document.querySelector(`[data-thread-item="${key(SOON_ID)}"]`)).not.toBeNull(),
      );
      const keys = [...document.querySelectorAll<HTMLElement>("[data-thread-item]")]
        .map((row) => row.dataset.threadItem)
        .filter((rowKey) => [key(SOON_ID), key(LATER_ID), key(OPEN)].includes(rowKey!));
      expect(keys).toEqual([key(SOON_ID), key(LATER_ID), key(OPEN)]);
      const row = document.querySelector(`[data-thread-item="${key(SOON_ID)}"]`)!;
      await userEvent.hover(row);
      await userEvent.click(row.querySelector<HTMLElement>('[aria-label="Wake thread now"]')!);
      await vi.waitFor(() => expect(fixture.threads.get(SOON_ID)?.snoozedUntil).toBeNull());
      await userEvent.click(snoozedHeader());
      await vi.waitFor(() => expect(snoozedHeader().getAttribute("aria-expanded")).toBe("false"));
      expect(window.localStorage.getItem(SNOOZED_KEY)).toBe("false");
    },
  );

  it("snoozed phase 1 guard Working tree: Search and arrows keep Working focus and keyboard expansion", async () => {
    using _clock = fixedClock();
    await using state = await setup({ empty: true });
    await using screen = await state.render();
    await expect.element(screen.getByRole("tree", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() => expect(search()).not.toBeNull());
    await act(async () => search().focus());
    await press("ArrowDown");
    expect(document.activeElement).toBe(workingHeader());
    expect(workingHeader().getAttribute("role")).toBe("treeitem");
    await press("ArrowRight");
    await vi.waitFor(() => expect(workingHeader().getAttribute("aria-expanded")).toBe("true"));
    await press("ArrowDown");
    expect(document.activeElement?.getAttribute("data-mesura-thread-key")).toBe(
      key("snoozed-fence-working"),
    );
    await press("ArrowUp");
    expect(document.activeElement).toBe(workingHeader());
    await press("ArrowLeft");
    await vi.waitFor(() => expect(workingHeader().getAttribute("aria-expanded")).toBe("false"));
    await press("ArrowUp");
    expect(document.activeElement).toBe(search());
  });
});
