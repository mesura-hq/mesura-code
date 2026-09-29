// @vitest-environment happy-dom
/**
 * Phase 6 guards for the Usage screen's pull to refresh, which the Hosts
 * screen's refresh follows and may come to share: `useRefreshLimits` probes
 * connected environments only, names the ones whose probe failed, commits
 * `refreshing` true while probes are in flight, and settles false.
 *
 * Entry point: `useRefreshLimits`, as UsageRouteScreen calls it, over a real
 * presentations atom; the provider probe is the test boundary.
 */
import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { hostPresentation } from "@t3tools/client-runtime/host-stats/fixtures";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  presentationsAtom: null as Atom.Writable<
    ReadonlyMap<EnvironmentId, EnvironmentPresentation>
  > | null,
  probed: [] as string[],
  failing: new Set<string>(),
  /** Holds every probe until the test releases it, so `refreshing: true` can commit first. */
  gate: Promise.resolve(),
}));

vi.mock(
  "react-native",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).reactNativeDom,
);
vi.mock(
  "../../components/AppText",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).appTextDom,
);
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./usageProviders", () => ({ useProviderColors: () => ({}) }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: {
    get presentationsAtom() {
      return fixture.presentationsAtom;
    },
  },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: {} } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (request: { readonly environmentId: string }) => {
    fixture.probed.push(request.environmentId);
    await fixture.gate;
    return fixture.failing.has(request.environmentId)
      ? { _tag: "Failure", cause: "probe failed" }
      : { _tag: "Success", value: undefined };
  },
}));

import { useRefreshLimits } from "./UsageLimitsSection";

type RefreshLimits = ReturnType<typeof useRefreshLimits>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let registry: AtomRegistry.AtomRegistry | null = null;
const renders: RefreshLimits[] = [];

function Probe() {
  renders.push(useRefreshLimits());
  return null;
}

function fleet(phases: Readonly<Record<string, "connected" | "offline">>) {
  return new Map(
    Object.entries(phases).map(([id, phase]) => {
      const presentation = hostPresentation({ id, phase });
      return [presentation.entry.target.environmentId, presentation] as const;
    }),
  );
}

async function mountProbe(presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>) {
  fixture.presentationsAtom = Atom.make(presentations).pipe(Atom.keepAlive);
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <RegistryContext.Provider value={registry!}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
}

/** Starts a refresh, lets React commit while the probes are held, then releases them. */
async function pull() {
  const before = renders.length;
  let release = () => {};
  fixture.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshing: Promise<void> = Promise.resolve();
  await act(async () => {
    refreshing = renders.at(-1)!.refresh();
  });
  await act(async () => {
    release();
    await refreshing;
  });
  return renders.slice(before);
}

beforeEach(() => {
  renders.length = 0;
  fixture.probed = [];
  fixture.failing.clear();
  fixture.gate = Promise.resolve();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  registry?.dispose();
  registry = null;
});

describe("the Usage screen's pull to refresh", () => {
  it("usage refresh guard: probes connected environments only and names the failed ones", async () => {
    await mountProbe(fleet({ alpha: "connected", beta: "connected", gamma: "offline" }));
    fixture.failing.add("beta");

    const during = await pull();

    expect(fixture.probed.toSorted()).toEqual(["alpha", "beta"]);
    expect(during.map((render) => render.refreshing)).toContain(true);
    expect(renders.at(-1)!.refreshing).toBe(false);
    expect(renders.at(-1)!.failedLabels).toEqual(["beta"]);
  });

  // With nothing to probe, the hook sets `refreshing` true and false one
  // microtask apart, and React commits them as one render: `true` is never
  // seen. The guard pins what holds today — the refresh settles with the
  // spinner off — not the true-then-false its comment promises.
  it("usage refresh guard: settles with the spinner off when there is nothing to probe", async () => {
    await mountProbe(fleet({ alpha: "offline" }));

    await pull();

    expect(fixture.probed).toEqual([]);
    expect(renders.at(-1)!.refreshing).toBe(false);
  });
});
