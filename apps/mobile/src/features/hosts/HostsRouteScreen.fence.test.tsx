// @vitest-environment happy-dom
/**
 * Entry point: HostsRouteScreen, the screen `Stack.tsx` registers as
 * `SettingsHosts`, mounted in an atom registry of its own. The shared host
 * stats projection, the screen's clock and its refresh stay real. The fixture
 * replaces only the transport: the environments' presentations atom and the
 * `serverEnvironment.hostStats` family, whose atoms count every read and every
 * release so a test can see a subscription open, restart and let go.
 *
 * Phase 6 fence, criteria 4 to 7. Native primitives render as DOM through
 * `reactNativeDomTestDoubles`; what only the Android app can show — the
 * spinner as drawn, the dimming, the sparkline at phone width — is left to the
 * emulator verifier.
 */
import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { HostStatsSubscription } from "@t3tools/client-runtime/host-stats";
import {
  HOUR,
  MINUTE,
  SECOND,
  hostHistory,
  hostPresentation,
  hostStatsFleet,
} from "@t3tools/client-runtime/host-stats/fixtures";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useEffect, useSyncExternalStore, type EffectCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type HostStatsResult = AsyncResult.AsyncResult<HostStatsSubscription, unknown>;

const transport = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  presentationsAtom: null as Atom.Writable<
    ReadonlyMap<EnvironmentId, EnvironmentPresentation>
  > | null,
  sources: new Map<string, Atom.Writable<HostStatsResult>>(),
  family: new Map<string, Atom.Atom<HostStatsResult>>(),
  reads: new Map<string, number>(),
  held: new Set<string>(),
  focused: true,
  focusListeners: new Set<() => void>(),
  navigation: {
    goBack: vi.fn(),
    navigate: vi.fn(),
    setOptions: vi.fn(),
    isFocused: () => transport.focused,
    /** `focus` and `blur`, from the same switch `useIsFocused` reads. */
    addListener: (event: string, listener: () => void) => {
      const onChange = () => {
        if ((event === "focus" && transport.focused) || (event === "blur" && !transport.focused)) {
          listener();
        }
      };
      transport.focusListeners.add(onChange);
      return () => transport.focusListeners.delete(onChange);
    },
  },
}));

vi.mock("react-native", async () => (await import("./reactNativeDomTestDoubles")).reactNativeDom);
vi.mock(
  "react-native-svg",
  async () => (await import("./reactNativeDomTestDoubles")).reactNativeSvgDom,
);
vi.mock("uniwind", async () => (await import("./reactNativeDomTestDoubles")).uniwindDom);
vi.mock(
  "../../components/AppText",
  async () => (await import("./reactNativeDomTestDoubles")).appTextDom,
);
vi.mock(
  "../../components/AppSymbol",
  async () => (await import("./reactNativeDomTestDoubles")).appSymbolDom,
);
vi.mock("../../components/AndroidScreenHeader", () => ({
  AndroidScreenHeader: (props: { title: string }) => <h1>{props.title}</h1>,
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  NativeHeaderToolbar: { Button: () => null },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => {
  const subscribe = (onChange: () => void) => {
    transport.focusListeners.add(onChange);
    return () => transport.focusListeners.delete(onChange);
  };
  const useIsFocused = () => useSyncExternalStore(subscribe, () => transport.focused);
  return {
    useNavigation: () => transport.navigation,
    useRoute: () => ({ key: "SettingsHosts", name: "SettingsHosts", params: undefined }),
    useIsFocused,
    useFocusEffect: (effect: EffectCallback) => {
      const focused = useIsFocused();
      useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
  };
});
vi.mock("../../state/atom-registry", () => ({
  get appAtomRegistry() {
    return transport.registry;
  },
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: {
    get presentationsAtom() {
      return transport.presentationsAtom;
    },
  },
}));
vi.mock("../../state/server", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  const sourceFor = (environmentId: string) => {
    let source = transport.sources.get(environmentId);
    if (source === undefined) {
      source = Atom.make<HostStatsResult>(AsyncResult.initial(true)).pipe(Atom.keepAlive);
      transport.sources.set(environmentId, source);
    }
    return source;
  };
  const hostStats = (key: { readonly environmentId: string }) => {
    let atom = transport.family.get(key.environmentId);
    if (atom === undefined) {
      atom = Atom.make((get) => {
        transport.reads.set(key.environmentId, (transport.reads.get(key.environmentId) ?? 0) + 1);
        transport.held.add(key.environmentId);
        get.addFinalizer(() => transport.held.delete(key.environmentId));
        return get(sourceFor(key.environmentId));
      });
      transport.family.set(key.environmentId, atom);
    }
    return atom;
  };
  return { serverEnvironment: { hostStats } };
});

import { appStateControl, refreshControlLog, setAppState } from "./reactNativeDomTestDoubles";
import { HostsRouteScreen } from "./HostsRouteScreen";

const NOW = Date.UTC(2026, 8, 29, 10, 0, 0);
const HOST_IDS = ["vigilia-home", "arch-laptop", "conversa", "old-box"] as const;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function registry(): AtomRegistry.AtomRegistry {
  if (transport.registry === null) throw new Error("no registry");
  return transport.registry;
}

function setPresentations(presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>) {
  registry().set(transport.presentationsAtom!, presentations);
}

function setSubscription(environmentId: string, result: HostStatsResult) {
  const source = transport.sources.get(environmentId);
  if (source !== undefined) {
    registry().set(source, result);
    return;
  }
  const created = Atom.make<HostStatsResult>(result).pipe(Atom.keepAlive);
  transport.sources.set(environmentId, created);
}

function loadFleet(fleet: {
  readonly presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly subscriptions: ReadonlyMap<EnvironmentId, HostStatsSubscription>;
}) {
  setPresentations(fleet.presentations);
  for (const [environmentId, subscription] of fleet.subscriptions) {
    setSubscription(environmentId, AsyncResult.success(subscription));
  }
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RegistryContext.Provider value={registry()}>
        <HostsRouteScreen />
      </RegistryContext.Provider>,
    );
  });
  await flush();
}

async function unmount() {
  await act(async () => root?.unmount());
  root = null;
  await flush();
}

async function setFocused(focused: boolean) {
  await act(async () => {
    transport.focused = focused;
    for (const listener of [...transport.focusListeners]) listener();
  });
  await flush();
}

async function moveAppTo(state: "active" | "background") {
  await act(async () => setAppState(state));
  await flush();
}

function hostSection(environmentId: string): HTMLElement {
  const section = container?.querySelector<HTMLElement>(`[data-testid="host:${environmentId}"]`);
  if (!section) throw new Error(`no section for host ${environmentId}`);
  return section;
}

function hostRow(environmentId: string, rowId: string): HTMLElement {
  const row = hostSection(environmentId).querySelector<HTMLElement>(
    `[data-testid="host-row:${rowId}"]`,
  );
  if (!row) throw new Error(`no ${rowId} row for host ${environmentId}`);
  return row;
}

function renderedHostIds(): string[] {
  return Array.from(
    container?.querySelectorAll<HTMLElement>('[data-testid^="host:"]') ?? [],
    (element) => element.dataset.testid!.slice("host:".length),
  );
}

function text(element: Element | null | undefined): string {
  return element?.textContent ?? "";
}

function pathSubpathCounts(row: HTMLElement): number[] {
  return Array.from(
    row.querySelectorAll("path"),
    (path) => (path.getAttribute("d") ?? "").split("M").length - 1,
  ).filter((count) => count > 0);
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(NOW);
  transport.registry = AtomRegistry.make();
  transport.presentationsAtom = Atom.make<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>(
    new Map(),
  ).pipe(Atom.keepAlive);
  transport.sources.clear();
  transport.family.clear();
  transport.reads.clear();
  transport.held.clear();
  transport.focused = true;
  transport.focusListeners.clear();
  transport.navigation.goBack.mockClear();
  transport.navigation.navigate.mockClear();
  appStateControl.current = "active";
  appStateControl.listeners.clear();
  refreshControlLog.values = [];
});

afterEach(async () => {
  await unmount();
  container?.remove();
  container = null;
  transport.registry?.dispose();
  transport.registry = null;
  vi.useRealTimers();
});

describe("criterion 4: every environment, with the web dock's rows, states and levels", () => {
  /**
   * The fixture fleet, with the primary host's processor at 97 % (red) and
   * its swap at 5 of 7.6 GiB, 66 % (amber).
   */
  function troubledFleet() {
    const fleet = hostStatsFleet(NOW);
    const presentations = new Map(fleet.presentations);
    const subscriptions = new Map(fleet.subscriptions);
    const primary = hostPresentation({ id: "vigilia-home", primary: true });
    const primaryId = primary.entry.target.environmentId;
    presentations.set(primaryId, primary);
    subscriptions.set(primaryId, {
      history: hostHistory({
        now: NOW,
        latestAgeMs: 20 * SECOND,
        gapSlots: [100, 104],
        sample: { cpuPercent: 97, swapUsedBytes: 5 * 1024 ** 3 },
      }),
      failed: false,
    });
    return { presentations, subscriptions };
  }

  it("hosts screen lists every environment of the projection, primary first then by label", async () => {
    loadFleet(troubledFleet());
    await mount();

    expect(text(container?.querySelector("h1"))).toBe("Hosts");
    expect(renderedHostIds()).toEqual([...HOST_IDS]);
    expect(text(container)).toContain("3 of 4 online · 4 agents running");
  });

  it("hosts screen renders the dock's rows and values for a live host", async () => {
    loadFleet(troubledFleet());
    await mount();

    const expected: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
      ["cpu", "CPU", ["97%", "ld 2.5"]],
      ["memory", "RAM", ["14.6", "/30.0G"]],
      ["swap", "Swap", ["5", "/7.6G"]],
      ["disk", "Disk", ["17%", "793G"]],
      ["gpu", "GPU", ["12%", "vram 13%"]],
      ["temperature", "Temp", ["48°C"]],
      ["network", "Net", ["↓12K", "↑3K"]],
      ["agents", "Agents", ["4", "/11"]],
    ];
    const rows = Array.from(
      hostSection("vigilia-home").querySelectorAll<HTMLElement>('[data-testid^="host-row:"]'),
      (row) => row.dataset.testid,
    );
    expect(rows).toEqual(expected.map(([rowId]) => `host-row:${rowId}`));
    for (const [rowId, label, values] of expected) {
      const row = hostRow("vigilia-home", rowId);
      expect(text(row)).toContain(label);
      for (const value of values) expect(text(row)).toContain(value);
    }
    expect(text(hostSection("vigilia-home"))).toContain("9 servers · 8 dev");
    expect(text(hostSection("vigilia-home"))).toContain("up 2h 27m");
  });

  it("hosts screen names each row's warning level where colour alone would carry it", async () => {
    loadFleet(troubledFleet());
    await mount();

    expect(hostRow("vigilia-home", "cpu").getAttribute("aria-label")).toMatch(/critical/i);
    expect(hostRow("vigilia-home", "swap").getAttribute("aria-label")).toMatch(/warning/i);
    for (const rowId of ["memory", "disk", "gpu", "temperature", "network", "agents"]) {
      expect(hostRow("vigilia-home", rowId).getAttribute("aria-label")).not.toMatch(
        /critical|warning/i,
      );
    }
  });

  it("hosts screen says why a host's numbers are not current, in the dock's words", async () => {
    loadFleet(troubledFleet());
    await mount();

    expect(text(hostSection("vigilia-home"))).not.toMatch(/Stale|Offline|Waiting|Update/);
    expect(text(hostSection("arch-laptop"))).toContain("Stale · last reading 3m ago");
    expect(text(hostSection("conversa"))).toContain("Offline · last reading 14m ago");
    expect(text(hostSection("old-box"))).toContain("Update Mesura Code on this host");
    expect(hostSection("old-box").querySelector('[data-testid^="host-row:"]')).toBeNull();
    // Stale and offline keep their last numbers on screen rather than hiding them.
    expect(text(hostRow("arch-laptop", "agents"))).toContain("1");
    expect(text(hostRow("conversa", "cpu"))).toContain("17%");
  });

  it("hosts screen breaks a sparkline where the host has no bucket", async () => {
    loadFleet(troubledFleet());
    await mount();

    const withGap = pathSubpathCounts(hostRow("vigilia-home", "cpu"));
    expect(withGap.length).toBeGreaterThan(0);
    for (const count of withGap) expect(count).toBeGreaterThanOrEqual(2);
    const withoutGap = pathSubpathCounts(hostRow("arch-laptop", "cpu"));
    expect(withoutGap.length).toBeGreaterThan(0);
    for (const count of withoutGap) expect(count).toBe(1);
  });
});

describe("criterion 5: pull to refresh", () => {
  it("hosts screen pull to refresh resubscribes every connected environment and no other", async () => {
    loadFleet(hostStatsFleet(NOW));
    await mount();
    const before = new Map(transport.reads);

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="refresh-control"]')!.click();
    });
    await flush();

    for (const environmentId of ["vigilia-home", "arch-laptop", "old-box"]) {
      expect(transport.reads.get(environmentId) ?? 0).toBeGreaterThan(
        before.get(environmentId) ?? 0,
      );
    }
    expect(transport.reads.get("conversa") ?? 0).toBe(before.get("conversa") ?? 0);
  });

  it("hosts screen pull to refresh shows the spinner and always ends it", async () => {
    loadFleet(hostStatsFleet(NOW));
    await mount();
    const pulledAt = refreshControlLog.values.length;

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="refresh-control"]')!.click();
    });
    await flush();
    await advance(10 * SECOND);

    const afterPull = refreshControlLog.values.slice(pulledAt);
    expect(afterPull).toContain(true);
    expect(afterPull.at(-1)).toBe(false);
    expect(
      container!.querySelector('[data-testid="refresh-control"]')!.getAttribute("data-refreshing"),
    ).toBe("false");
  });

  it("hosts screen pull to refresh ends the spinner with no environment connected", async () => {
    const fleet = hostStatsFleet(NOW);
    const offline = new Map(
      [...fleet.presentations].map(([environmentId, presentation]) => [
        environmentId,
        { ...presentation, connection: { ...presentation.connection, phase: "offline" as const } },
      ]),
    );
    loadFleet({ presentations: offline, subscriptions: fleet.subscriptions });
    await mount();
    const pulledAt = refreshControlLog.values.length;

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="refresh-control"]')!.click();
    });
    await flush();
    await advance(10 * SECOND);

    // Android's RefreshControl keeps its spinner until it sees true, then false.
    const afterPull = refreshControlLog.values.slice(pulledAt);
    expect(afterPull).toContain(true);
    expect(afterPull.at(-1)).toBe(false);
  });
});

describe("criterion 6: the screen holds subscriptions only while it is seen", () => {
  it("hosts screen releases every subscription when it is left", async () => {
    loadFleet(hostStatsFleet(NOW));
    await mount();
    expect(transport.held).toContain("vigilia-home");
    expect(transport.held).toContain("arch-laptop");

    await unmount();

    expect([...transport.held]).toEqual([]);
  });

  it("hosts screen releases every subscription while another screen covers it", async () => {
    loadFleet(hostStatsFleet(NOW));
    await mount();

    await setFocused(false);
    expect([...transport.held]).toEqual([]);

    await setFocused(true);
    expect(transport.held).toContain("vigilia-home");
    expect(transport.held).toContain("arch-laptop");
  });

  it("hosts screen releases every subscription while the app is in the background", async () => {
    loadFleet(hostStatsFleet(NOW));
    await mount();

    await moveAppTo("background");
    expect([...transport.held]).toEqual([]);

    await moveAppTo("active");
    expect(transport.held).toContain("vigilia-home");
    expect(transport.held).toContain("arch-laptop");
  });

  it("hosts screen shows the last values with their age on return until fresh data arrives", async () => {
    loadFleet(hostStatsFleet(NOW));
    await mount();
    expect(text(hostRow("vigilia-home", "cpu"))).toContain("17%");

    await moveAppTo("background");
    // A subscription that restarts after its idle time starts empty.
    for (const environmentId of HOST_IDS) {
      setSubscription(environmentId, AsyncResult.initial(true));
    }
    vi.setSystemTime(NOW + 5 * MINUTE);
    await advance(0);
    await moveAppTo("active");

    expect(text(hostRow("vigilia-home", "cpu"))).toContain("17%");
    expect(text(hostSection("vigilia-home"))).toContain("Stale · last reading 5m ago");
    expect(text(hostSection("arch-laptop"))).toContain("Stale · last reading 8m ago");
    expect(text(container)).not.toContain("Waiting for the first reading");

    const later = NOW + 5 * MINUTE;
    await act(async () => {
      setSubscription(
        "vigilia-home",
        AsyncResult.success({
          history: hostHistory({ now: later, latestAgeMs: 5 * SECOND, sample: { cpuPercent: 42 } }),
          failed: false,
        }),
      );
    });
    await flush();

    expect(text(hostRow("vigilia-home", "cpu"))).toContain("42%");
    expect(text(hostSection("vigilia-home"))).not.toContain("Stale");
  });

  // Review P1-1: within the stale threshold, a held reading once projected as
  // live, with no age, and its agents entered the live total.
  it("hosts screen shows a held reading as updating, not live, after a short return", async () => {
    loadFleet(hostStatsFleet(NOW));
    await mount();
    expect(text(container)).toContain("4 agents running");

    await moveAppTo("background");
    for (const environmentId of HOST_IDS) {
      setSubscription(environmentId, AsyncResult.initial(true));
    }
    vi.setSystemTime(NOW + 30 * SECOND);
    await advance(0);
    await moveAppTo("active");

    expect(text(hostRow("vigilia-home", "cpu"))).toContain("17%");
    expect(text(hostSection("vigilia-home"))).toContain("Updating · last reading just now");
    expect(text(container)).toContain("0 agents running");

    await act(async () => {
      setSubscription(
        "vigilia-home",
        AsyncResult.success({
          history: hostHistory({ now: NOW + 30 * SECOND, latestAgeMs: 5 * SECOND }),
          failed: false,
        }),
      );
    });
    await flush();

    expect(text(hostSection("vigilia-home"))).not.toContain("Updating");
    expect(text(container)).toContain("4 agents running");
  });

  it("hosts screen moves ages while seen, at most every 15 s, and not while hidden", async () => {
    loadFleet(hostStatsFleet(NOW));
    await mount();
    // arch-laptop's reading is 235 s old: "3m ago" until 240 s.
    expect(text(hostSection("arch-laptop"))).toContain("Stale · last reading 3m ago");

    await advance(5 * SECOND);
    expect(text(hostSection("arch-laptop"))).toContain("Stale · last reading 3m ago");

    await advance(10 * SECOND);
    expect(text(hostSection("arch-laptop"))).toContain("Stale · last reading 4m ago");

    await moveAppTo("background");
    await advance(2 * MINUTE);
    expect(text(hostSection("arch-laptop"))).toContain("Stale · last reading 4m ago");

    await moveAppTo("active");
    expect(text(hostSection("arch-laptop"))).toContain("Stale · last reading 6m ago");
  });
});

describe("criterion 7: a phone without network", () => {
  it("hosts screen shows every host offline with the age of its last reading", async () => {
    const fleet = hostStatsFleet(NOW);
    const offline = new Map(
      [...fleet.presentations].map(([environmentId, presentation]) => [
        environmentId,
        { ...presentation, connection: { ...presentation.connection, phase: "offline" as const } },
      ]),
    );
    setPresentations(offline);
    // The transport failed under each stream: a failure that keeps what it had folded.
    for (const [environmentId, subscription] of fleet.subscriptions) {
      setSubscription(
        environmentId,
        AsyncResult.failure(Cause.fail("socket closed"), {
          previousSuccess: Option.some(AsyncResult.success(subscription)),
        }),
      );
    }
    await mount();

    expect(renderedHostIds()).toEqual([...HOST_IDS]);
    expect(text(hostSection("vigilia-home"))).toContain("Offline · last reading just now");
    expect(text(hostSection("arch-laptop"))).toContain("Offline · last reading 3m ago");
    expect(text(hostSection("conversa"))).toContain("Offline · last reading 14m ago");
    expect(text(hostSection("old-box"))).toContain("Offline · no reading this session");
    expect(text(hostRow("vigilia-home", "cpu"))).toContain("17%");
    expect(text(container)).toContain("0 of 4 online");
    expect(text(container)).not.toMatch(/error|could not|failed/i);
  });

  it("hosts screen ages offline readings while it stays open", async () => {
    const fleet = hostStatsFleet(NOW);
    setPresentations(
      new Map(
        [...fleet.presentations].map(([environmentId, presentation]) => [
          environmentId,
          {
            ...presentation,
            connection: { ...presentation.connection, phase: "offline" as const },
          },
        ]),
      ),
    );
    for (const [environmentId, subscription] of fleet.subscriptions) {
      setSubscription(environmentId, AsyncResult.success(subscription));
    }
    await mount();
    expect(text(hostSection("conversa"))).toContain("Offline · last reading 14m ago");

    await advance(1 * HOUR);

    expect(text(hostSection("conversa"))).toContain("Offline · last reading 1h 14m ago");
  });
});
