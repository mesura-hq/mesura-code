import { act, render as renderBrowser, type Screen, fakeTimers } from "../../../test/render";
/**
 * AppRoot with a memory router rendering the real sidebar footer, both docks, their controllers,
 * the shipped keybindings, the host stats projection and the dock's clock. Only the transport is
 * replaced: the environments list, the usage dock's data and the hosts dock's sources. What only
 * a real browser shows (dimming, layout at 224 px and 400 px) is left to the headless verifier.
 */

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AppRouter } from "../../router";
import type { HostStatsSources } from "../../state/hostStats";

const fixture = vi.hoisted(() => ({
  sources: null as HostStatsSources | null,
  sourcesEnabled: [] as boolean[],
  mobile: false,
}));

// The sidebar's own mobile test: a phone-width viewport has no docks at all.
vi.mock("../../hooks/useMediaQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useMediaQuery")>()),
  useIsMobile: () => fixture.mobile,
}));

vi.mock("../../state/hostStats", () => ({
  useHostStatsSources: (enabled: boolean) => {
    fixture.sourcesEnabled.push(enabled);
    return fixture.sources;
  },
}));
vi.mock("../../state/accountLimits", () => {
  const view = {
    environments: [],
    rows: [],
    isPending: false,
    isPartial: false,
    refresh: () => {},
  };
  return { useAccountLimits: () => view };
});
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [], isReady: true }),
}));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("../preview/PreviewAutomationHosts", () => ({ PreviewAutomationHosts: () => null }));
vi.mock("../../browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("../QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));

const { AppRoot } = await import("../../AppRoot");
const { SidebarProvider } = await import("../ui/sidebar");
const { SidebarChromeFooter } = await import("./SidebarChrome");
import { requestSidebarDockPin } from "./sidebarDockController";
import {
  NO_ACCESS_HOST_ID,
  PRIMARY_GAP_SLOTS,
  SECOND,
  SLOTS,
  STALE_HOST_AGE_MS,
  hostStatsFleet,
  withNoAccessHost,
} from "@t3tools/client-runtime/host-stats/fixtures";

const ROW_IDS = [
  "cpu",
  "memory",
  "swap",
  "disk",
  "gpu",
  "temperature",
  "network",
  "agents",
] as const;
const SPARKLINE_ROWS = new Set(["cpu", "memory", "gpu", "temperature", "network", "agents"]);
const BAR_ROWS = new Set(["swap", "disk"]);

let root: Screen | undefined;
let container: HTMLDivElement;
let router: ReturnType<typeof createRouter>;
const now = Date.UTC(2026, 8, 29, 10, 0, 0);

async function setupBrowserFixture0() {
  vi.setSystemTime(now);
  fixture.sources = hostStatsFleet(now);
  fixture.sourcesEnabled = [];
  fixture.mobile = false;
  container = document.createElement("div");
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      vi.useRealTimers();
      await root?.[Symbol.asyncDispose]();
      root = undefined;
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

async function mountSidebar(options: { path?: string; sidebarOpen?: boolean } = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider defaultOpen={options.sidebarOpen ?? true}>
        <SidebarChromeFooter />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const usage = createRoute({ getParentRoute: () => rootRoute, path: "/usage" });
  const settings = createRoute({ getParentRoute: () => rootRoute, path: "/settings" });
  const pullRequests = createRoute({ getParentRoute: () => rootRoute, path: "/pull-requests" });
  router = createRouter({
    routeTree: rootRoute.addChildren([index, usage, settings, pullRequests]),
    history: createMemoryHistory({ initialEntries: [options.path ?? "/"] }),
  });
  await router.load();
  await act(async () => {
    // AppRoot owns this fixture's memory router.
    root = await renderBrowser(null, { container, router: false });
    await root.rerender(<AppRoot router={router as unknown as AppRouter} />);
  });
}

function footerButton(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const labels = [...container.querySelectorAll("button[aria-label]")].map((entry) =>
    entry.getAttribute("aria-label"),
  );
  expect(button, `Expected a footer button "${label}"; found ${labels.join(", ")}`).not.toBeNull();
  return button!;
}

function hostsPanel(): HTMLElement {
  const panel = container.querySelector<HTMLElement>("[data-hosts-panel]");
  expect(panel, "Expected the hosts dock in the sidebar").not.toBeNull();
  return panel!;
}

function usagePanel(): HTMLElement {
  const panel = container.querySelector<HTMLElement>("[data-usage-limits-panel]");
  expect(panel, "Expected the usage dock in the sidebar").not.toBeNull();
  return panel!;
}

/** A closed dock is `inert`: out of focus, pointer targeting and find-in-page. */
const isOpen = (panel: HTMLElement) => panel.closest("[inert]") === null;
const hostsOpen = () => isOpen(hostsPanel());
const usageOpen = () => isOpen(usagePanel());

async function press(type: "keydown" | "keyup", init: KeyboardEventInit) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}

const ALT_S = { key: "s", code: "KeyS", altKey: true };
const ALT_U = { key: "u", code: "KeyU", altKey: true };

async function pointer(target: Element, type: "pointerover" | "pointerout") {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, relatedTarget: document.body, pointerId: 1 }),
    );
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function hostSection(id: string): HTMLElement {
  const section = hostsPanel().querySelector<HTMLElement>(`[data-host="${id}"]`);
  expect(section, `Expected host ${id}; rendered: ${hostsPanel().textContent}`).not.toBeNull();
  return section!;
}

describe("Hosts dock criterion 1: held Alt+S", () => {
  it("opens the hosts dock while Alt+S is held and closes it when S is released", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    expect(hostsOpen()).toBe(false);
    await press("keydown", ALT_S);
    expect(hostsOpen()).toBe(true);
    await press("keyup", ALT_S);
    expect(hostsOpen()).toBe(false);
  });

  it("closes the held hosts dock when Alt is released first", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    expect(hostsOpen()).toBe(true);
    await press("keyup", { key: "Alt", code: "AltLeft", altKey: false });
    expect(hostsOpen()).toBe(false);
  });

  it("shows the Alt+S chord in the hosts dock header", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    expect(hostsPanel().querySelector("kbd")?.textContent).toBe("Alt+S");
  });

  it("subscribes to host stats only once the hosts dock opens", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    expect(fixture.sourcesEnabled.length).toBeGreaterThan(0);
    expect(fixture.sourcesEnabled.every((enabled) => !enabled)).toBe(true);
    await press("keydown", ALT_S);
    expect(fixture.sourcesEnabled.at(-1)).toBe(true);
  });
});

describe("Hosts dock criterion 2: the footer server icon", () => {
  it("opens the hosts dock on hover and keeps it across the 120 ms bridge", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    using _timers = fakeTimers();
    const button = footerButton("Hosts");
    await pointer(button, "pointerover");
    expect(hostsOpen()).toBe(true);
    await pointer(button, "pointerout");
    await advance(100);
    expect(hostsOpen()).toBe(true);
    await advance(40);
    expect(hostsOpen()).toBe(false);
  });

  it("pins the hosts dock on click and unpins it on a second click", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    using _timers = fakeTimers();
    const button = footerButton("Hosts");
    await pointer(button, "pointerover");
    await act(async () => button.click());
    await pointer(button, "pointerout");
    await advance(1_000);
    expect(hostsOpen()).toBe(true);
    await pointer(button, "pointerover");
    await act(async () => button.click());
    await pointer(button, "pointerout");
    await advance(1_000);
    expect(hostsOpen()).toBe(false);
  });

  it("unpins and closes a pinned hosts dock on Escape", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    const button = footerButton("Hosts");
    await act(async () => button.click());
    expect(hostsOpen()).toBe(true);
    await press("keydown", { key: "Escape", code: "Escape" });
    expect(hostsOpen()).toBe(false);
  });

  it("pins the hosts dock from the command palette's Show hosts request", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await act(async () => requestSidebarDockPin("hosts"));
    expect(hostsOpen()).toBe(true);
    await press("keydown", { key: "Escape", code: "Escape" });
    expect(hostsOpen()).toBe(false);
  });
});

// Review P1-1: Show hosts is offered on every wide-viewport page, so it has to
// end with the dock visible wherever it was chosen.
describe("Hosts dock: the palette's Show hosts from every page", () => {
  const sidebarState = () =>
    container.querySelector<HTMLElement>("[data-sidebar-state]")?.dataset.sidebarState;

  it.each(["/usage", "/settings", "/pull-requests"])(
    "Show hosts from %s returns to the thread list and pins the hosts dock",
    async (path) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await mountSidebar({ path });
      expect(container.querySelector("[data-hosts-panel]")).toBeNull();
      await act(async () => requestSidebarDockPin("hosts"));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
      await vi.waitFor(() => expect(hostsOpen()).toBe(true));
      // Pinned, not hovered: it stays until Escape.
      await press("keydown", { key: "Escape", code: "Escape" });
      expect(hostsOpen()).toBe(false);
    },
  );

  it("Show hosts expands a collapsed sidebar before pinning the hosts dock", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar({ sidebarOpen: false });
    expect(sidebarState()).toBe("collapsed");
    await act(async () => requestSidebarDockPin("hosts"));
    expect(sidebarState()).toBe("expanded");
    expect(hostsOpen()).toBe(true);
    await press("keydown", { key: "Escape", code: "Escape" });
    expect(hostsOpen()).toBe(false);
  });
});

describe("Hosts dock regressions: requests and pins that must not linger", () => {
  // Review P1-1: at a phone width there is no dock to show, so the request is
  // dropped where it lands. Held, it would pin the dock the next time a wide
  // sidebar mounted, long after the user asked.
  it("drops a Show hosts request at mobile width instead of holding it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar({ path: "/usage" });
    await act(async () => requestSidebarDockPin("hosts"));
    expect(router.state.location.pathname).toBe("/usage");
    expect(container.querySelector("[data-hosts-panel]")).toBeNull();
    await root?.[Symbol.asyncDispose]();
    fixture.mobile = false;
    await mountSidebar();
    expect(hostsOpen()).toBe(false);
  });

  // The pin lives in a module-level atom that outlives any one sidebar. A
  // sidebar that goes away takes its dock's pin with it, so a fresh sidebar
  // starts closed rather than inheriting a pin nobody can see being set.
  it("starts a freshly mounted sidebar with the hosts dock closed after a pinned one unmounts", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await act(async () => footerButton("Hosts").click());
    expect(hostsOpen()).toBe(true);
    await root?.[Symbol.asyncDispose]();
    await mountSidebar();
    expect(hostsOpen()).toBe(false);
    expect(usageOpen()).toBe(false);
  });
});

describe("Hosts dock criterion 3: one sidebar dock at a time", () => {
  it("closes a pinned hosts dock while Alt+U opens the usage dock", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await act(async () => footerButton("Hosts").click());
    expect(hostsOpen()).toBe(true);
    await press("keydown", ALT_U);
    expect(usageOpen()).toBe(true);
    expect(hostsOpen()).toBe(false);
  });

  it("closes a hovered usage dock while Alt+S opens the hosts dock", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await pointer(footerButton("Usage"), "pointerover");
    expect(usageOpen()).toBe(true);
    await press("keydown", ALT_S);
    expect(hostsOpen()).toBe(true);
    expect(usageOpen()).toBe(false);
  });
});

describe("Hosts dock criterion 3: a yielded dock stays closed", () => {
  it("does not reopen a pinned hosts dock after the usage peek it yielded to closes", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await act(async () => footerButton("Hosts").click());
    await press("keydown", ALT_U);
    await press("keyup", ALT_U);
    expect(usageOpen()).toBe(false);
    expect(hostsOpen()).toBe(false);
  });

  it("does not reopen a hovered usage dock after the hosts peek it yielded to closes", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await pointer(footerButton("Usage"), "pointerover");
    await press("keydown", ALT_S);
    await press("keyup", ALT_S);
    expect(hostsOpen()).toBe(false);
    expect(usageOpen()).toBe(false);
  });
});

describe("Hosts dock criterion 4: the Rows layout", () => {
  it("renders every host with its header, local tag and uptime", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    const hosts = [...hostsPanel().querySelectorAll<HTMLElement>("[data-host]")].map(
      (section) => section.dataset.host,
    );
    expect(hosts).toEqual(["vigilia-home", "arch-laptop", "conversa", "old-box"]);
    const primary = hostSection("vigilia-home");
    expect(primary.textContent).toContain("local");
    expect(primary.textContent).toContain("up 2h 27m");
    expect(hostSection("arch-laptop").textContent).not.toContain("local");
  });

  it("renders the eight rows with sparklines and bars where the plan puts them", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    const primary = hostSection("vigilia-home");
    const rows = [...primary.querySelectorAll<HTMLElement>("[data-host-row]")];
    expect(rows.map((row) => row.dataset.hostRow)).toEqual([...ROW_IDS]);
    for (const row of rows) {
      const id = row.dataset.hostRow!;
      expect(row.querySelector("[data-host-sparkline]") !== null, `${id} sparkline`).toBe(
        SPARKLINE_ROWS.has(id),
      );
      expect(row.querySelector("[data-host-bar]") !== null, `${id} bar`).toBe(BAR_ROWS.has(id));
    }
    const text = (id: string) =>
      primary.querySelector(`[data-host-row="${id}"]`)?.textContent ?? "";
    expect(text("cpu")).toContain("CPU");
    expect(text("cpu")).toContain("17%");
    expect(text("memory")).toContain("RAM");
    expect(text("disk")).toContain("793G");
    // Servers are prototype B's chip line under the rows, not a ninth row.
    expect(primary.querySelector("[data-host-servers]")?.textContent).toContain(
      "9 servers · 8 dev",
    );
  });

  it("draws a maximum band behind the CPU and GPU sparklines only", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    const primary = hostSection("vigilia-home");
    const band = (id: string) =>
      primary.querySelector(`[data-host-row="${id}"] [data-sparkline-peak]`) !== null;
    expect(band("cpu")).toBe(true);
    expect(band("gpu")).toBe(true);
    expect(band("memory")).toBe(false);
    expect(band("agents")).toBe(false);
  });

  it("summarises the fleet as online hosts and running agents", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    expect(hostsPanel().textContent).toContain("3 of 4 online · 4 agents running");
  });
});

describe("Hosts dock criterion 5: stale, offline and outdated hosts", () => {
  it("tells a device without access to pair again instead of updating the host", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.sources = withNoAccessHost(hostStatsFleet(now));
    await mountSidebar();
    await press("keydown", ALT_S);
    const refused = hostSection(NO_ACCESS_HOST_ID);
    expect(refused.dataset.hostState).toBe("no-access");
    expect(refused.textContent).toContain("No access · pair again with full access");
    expect(refused.textContent).not.toContain("Update Mesura Code");
  });

  it("marks a stale host with the age of its last reading and keeps its values", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    const stale = hostSection("arch-laptop");
    expect(stale.dataset.hostState).toBe("stale");
    expect(stale.textContent).toContain("Stale · last reading 3m ago");
    expect(stale.querySelectorAll("[data-host-row]")).toHaveLength(ROW_IDS.length);
  });

  it("marks an offline host with the age of its last reading and keeps its values", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    const offline = hostSection("conversa");
    expect(offline.dataset.hostState).toBe("offline");
    expect(offline.textContent).toContain("Offline · last reading 14m ago");
    expect(offline.querySelectorAll("[data-host-row]")).toHaveLength(ROW_IDS.length);
  });

  it("shows one update line and no rows for a host without the stream", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    const old = hostSection("old-box");
    expect(old.dataset.hostState).toBe("needs-update");
    expect(old.textContent).toContain("Update Mesura Code on this host");
    expect(old.querySelectorAll("[data-host-row]")).toHaveLength(0);
  });
});

describe("Hosts dock criterion 6: hover and gaps", () => {
  it("breaks the CPU line where the host has no buckets", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    const line = hostSection("vigilia-home").querySelector(
      '[data-host-row="cpu"] [data-sparkline-line]',
    );
    expect(line).not.toBeNull();
    // One gap in the window: two runs, so two moves.
    expect(line!.getAttribute("d")?.match(/M/g)).toHaveLength(2);
  });

  it("reads the hovered bucket's time and value under the pointer", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await press("keydown", ALT_S);
    const sparkline = hostSection("vigilia-home").querySelector<SVGSVGElement>(
      '[data-host-row="cpu"] [data-host-sparkline]',
    )!;
    Object.defineProperty(sparkline, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        width: SLOTS - 1,
        height: 20,
        right: SLOTS - 1,
        bottom: 20,
      }),
    });
    const hoverAt = async (clientX: number) =>
      await act(async () => {
        sparkline.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX, clientY: 10, pointerId: 1 }),
        );
      });
    const readout = () =>
      hostSection("vigilia-home").querySelector("[data-sparkline-readout]")?.textContent ?? "";

    await hoverAt(0);
    expect(readout()).toMatch(/\d{2}:\d{2}/);
    expect(readout()).toContain("20%");
    await hoverAt(PRIMARY_GAP_SLOTS[0]);
    expect(readout()).toContain("no reading");
  });
});

describe("Hosts dock criterion 8: ages refresh at most every 15 s, only while open", () => {
  it("moves a stale age on the 15 s refresh and not before it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    using _timers = fakeTimers({ now });
    await press("keydown", ALT_S);
    const stale = () => hostSection("arch-laptop").textContent ?? "";
    expect(stale()).toContain("last reading 3m ago");
    // The reading turns 4 minutes old 5 s from now; the dock may say so only
    // on its next refresh, 15 s after it opened.
    await advance(10 * SECOND);
    expect(STALE_HOST_AGE_MS + 10 * SECOND).toBeGreaterThan(4 * 60 * SECOND);
    expect(stale()).toContain("last reading 3m ago");
    await advance(5 * SECOND);
    expect(stale()).toContain("last reading 4m ago");
  });

  it("keeps the hosts dock ages on a 15 s cadence across several refreshes", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    using _timers = fakeTimers({ now });
    await press("keydown", ALT_S);
    const stale = () => hostSection("arch-laptop").textContent ?? "";
    // Refreshes land at +15, +30, +45, +60 and +75 s. The reading turns 5
    // minutes old at +65 s, which only the +75 s refresh may show.
    await advance(74 * SECOND);
    expect(stale()).toContain("last reading 4m ago");
    await advance(SECOND);
    expect(stale()).toContain("last reading 5m ago");
  });

  it("leaves the closed hosts dock's ages alone and refreshes them on reopening", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    using _timers = fakeTimers({ now });
    await press("keydown", ALT_S);
    await press("keyup", ALT_S);
    const stale = () => hostSection("arch-laptop").textContent ?? "";
    expect(stale()).toContain("last reading 3m ago");
    await advance(5 * 60 * SECOND);
    expect(stale()).toContain("last reading 3m ago");
    await press("keydown", ALT_S);
    expect(stale()).toContain("last reading 8m ago");
  });
});

describe("Usage dock guards (criterion 7)", () => {
  it("still opens the usage dock on held Alt+U and closes it on release", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    expect(usageOpen()).toBe(false);
    await press("keydown", ALT_U);
    expect(usageOpen()).toBe(true);
    await press("keyup", ALT_U);
    expect(usageOpen()).toBe(false);
  });

  it("still opens the usage dock on hover over the Usage icon", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await pointer(footerButton("Usage"), "pointerover");
    expect(usageOpen()).toBe(true);
  });

  it("still navigates to the usage page when the Usage icon is clicked", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    await act(async () => footerButton("Usage").click());
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/usage"));
  });
});

// A phone has no hover: a long press by touch on a footer icon pins its dock.
async function touch(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointerover" | "pointerout",
  at: { x: number; y: number } = { x: 10, y: 10 },
) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: "touch",
        clientX: at.x,
        clientY: at.y,
        relatedTarget: document.body,
      }),
    );
  });
}

/** The click a finger lift produces; `element.click()` would read as the keyboard's. */
async function liftClick(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

/** A touch tap as a phone sends it: hover-like events, then the click. */
async function tap(target: HTMLElement) {
  await touch(target, "pointerover");
  await touch(target, "pointerdown");
  await touch(target, "pointerup");
  await touch(target, "pointerout");
  await liftClick(target);
}

/** Holds a finger on the icon past the long-press delay, then lifts it. */
async function longPress(target: HTMLElement) {
  await touch(target, "pointerover");
  await touch(target, "pointerdown");
  await advance(450);
  await touch(target, "pointerup");
  await touch(target, "pointerout");
  await liftClick(target);
}

describe("Docks on a phone: long press on the footer icon", () => {
  it("opens the hosts dock on a long press and keeps it open after the finger lifts", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    const button = footerButton("Hosts");
    expect(hostsOpen()).toBe(false);
    await touch(button, "pointerdown");
    await advance(449);
    expect(hostsOpen()).toBe(false);
    await advance(1);
    expect(hostsOpen()).toBe(true);
    await touch(button, "pointerup");
    await touch(button, "pointerout");
    // The click the browser sends on lift is swallowed: it would unpin.
    await liftClick(button);
    await advance(1_000);
    expect(hostsOpen()).toBe(true);
    expect(fixture.sourcesEnabled.at(-1)).toBe(true);
  });

  it("opens the usage dock on a long press without leaving for the usage page", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    await longPress(footerButton("Usage"));
    await advance(1_000);
    expect(usageOpen()).toBe(true);
    expect(router.state.location.pathname).toBe("/");
  });

  it("closes a long-pressed dock on a touch outside it and keeps it on a touch inside", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    await longPress(footerButton("Hosts"));
    await touch(hostsPanel(), "pointerdown");
    await touch(hostsPanel(), "pointerup");
    expect(hostsOpen()).toBe(true);
    await touch(document.body, "pointerdown");
    expect(hostsOpen()).toBe(false);
  });

  it("does not open a dock when the finger moves away before the delay (a scroll)", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    const button = footerButton("Hosts");
    await touch(button, "pointerdown", { x: 10, y: 10 });
    await touch(button, "pointermove", { x: 10, y: 40 });
    await advance(1_000);
    expect(hostsOpen()).toBe(false);
  });

  it("a long press on one icon replaces the other dock", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    await longPress(footerButton("Usage"));
    expect(usageOpen()).toBe(true);
    await longPress(footerButton("Hosts"));
    expect(hostsOpen()).toBe(true);
    expect(usageOpen()).toBe(false);
  });

  it("a short tap on Usage still opens the usage page and flashes no dock", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    const button = footerButton("Usage");
    await touch(button, "pointerover");
    expect(usageOpen()).toBe(false);
    await touch(button, "pointerdown");
    await touch(button, "pointerup");
    await touch(button, "pointerout");
    await liftClick(button);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/usage"));
  });

  it("a short tap on Hosts pins its dock as a click does on the desktop", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    await tap(footerButton("Hosts"));
    await advance(1_000);
    expect(hostsOpen()).toBe(true);
  });

  it("swallows the context menu a long press raises while the finger is down", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    const button = footerButton("Hosts");
    await touch(button, "pointerdown");
    await advance(450);
    const duringPress = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      button.dispatchEvent(duringPress);
    });
    expect(duringPress.defaultPrevented).toBe(true);
    await touch(button, "pointerup");
    const afterLift = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      button.dispatchEvent(afterLift);
    });
    expect(afterLift.defaultPrevented).toBe(false);
  });

  it("a mouse click after a long press that sent no click still reaches the icon", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.mobile = true;
    await mountSidebar();
    using _timers = fakeTimers();
    const button = footerButton("Hosts");
    await touch(button, "pointerdown");
    await advance(450);
    await touch(button, "pointerup");
    expect(hostsOpen()).toBe(true);
    // No click from the browser; a later mouse click on the icon unpins.
    await act(async () => {
      button.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "mouse" }),
      );
    });
    await liftClick(button);
    await advance(1_000);
    expect(hostsOpen()).toBe(false);
  });

  it("a mouse right click on a dock icon keeps its context menu", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountSidebar();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      footerButton("Hosts").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});
