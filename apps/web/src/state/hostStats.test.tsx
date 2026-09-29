// @vitest-environment happy-dom
/**
 * Entry point: `useHostStatsSources`, the hook the Hosts dock reads its
 * sources through, mounted in an atom registry of its own. The fixture
 * replaces only the transport: the presentations atom and the
 * `serverEnvironment.hostStats` family, whose atoms stay alive between dock
 * opens as the real ones do for their five-minute idle TTL, and count every
 * time they start.
 */
import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { HostStatsSubscription } from "@t3tools/client-runtime/host-stats";
import {
  NO_ACCESS_HOST_ID,
  hostStatsFleet,
  withNoAccessHost,
} from "@t3tools/client-runtime/host-stats/fixtures";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type HostStatsResult = AsyncResult.AsyncResult<HostStatsSubscription, unknown>;

const transport = vi.hoisted(() => ({
  presentationsAtom: null as Atom.Writable<
    ReadonlyMap<EnvironmentId, EnvironmentPresentation>
  > | null,
  sources: new Map<string, Atom.Writable<HostStatsResult>>(),
  family: new Map<string, Atom.Atom<HostStatsResult>>(),
  starts: new Map<string, number>(),
}));

vi.mock("./presentation", () => ({
  environmentPresentations: {
    get presentationsAtom() {
      return transport.presentationsAtom;
    },
  },
}));
vi.mock("./server", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  const hostStats = (key: { readonly environmentId: string }) => {
    let atom = transport.family.get(key.environmentId);
    if (atom === undefined) {
      atom = Atom.make((get) => {
        transport.starts.set(key.environmentId, (transport.starts.get(key.environmentId) ?? 0) + 1);
        const source = transport.sources.get(key.environmentId);
        return source === undefined
          ? AsyncResult.initial<HostStatsSubscription>(true)
          : get(source);
      }).pipe(Atom.keepAlive);
      transport.family.set(key.environmentId, atom);
    }
    return atom;
  };
  return { serverEnvironment: { hostStats } };
});

import { useHostStatsSources } from "./hostStats";

const NOW = Date.UTC(2026, 8, 29, 10, 0, 0);

let registry: AtomRegistry.AtomRegistry;
let root: Root | null = null;
let container: HTMLDivElement;

function Dock(props: { readonly open: boolean }) {
  useHostStatsSources(props.open);
  return null;
}

async function render(open: boolean) {
  await act(async () => {
    root!.render(
      <RegistryContext.Provider value={registry}>
        <Dock open={open} />
      </RegistryContext.Provider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  transport.sources.clear();
  transport.family.clear();
  transport.starts.clear();
  const fleet = withNoAccessHost(hostStatsFleet(NOW));
  transport.presentationsAtom = Atom.make(fleet.presentations).pipe(Atom.keepAlive);
  for (const [environmentId, subscription] of fleet.subscriptions) {
    transport.sources.set(
      environmentId,
      Atom.make<HostStatsResult>(AsyncResult.success(subscription)).pipe(Atom.keepAlive),
    );
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("Hosts dock sources: a refused subscription", () => {
  const startsOf = (id: string) => transport.starts.get(id) ?? 0;

  it("hosts dock sources: reopening the dock starts a refused subscription again and no other", async () => {
    await render(true);
    const before = new Map(transport.starts);

    // Closed: the device is paired again in Settings, where the dock does not exist.
    await render(false);
    await render(true);
    expect(startsOf(NO_ACCESS_HOST_ID)).toBe(before.get(NO_ACCESS_HOST_ID)! + 1);
    for (const id of ["vigilia-home", "arch-laptop", "conversa", "old-box"]) {
      expect(startsOf(id), id).toBe(before.get(id));
    }
  });

  it("hosts dock sources: a refused subscription does not restart while the dock stays open", async () => {
    await render(true);
    const before = startsOf(NO_ACCESS_HOST_ID);
    await render(true);
    await render(true);
    expect(startsOf(NO_ACCESS_HOST_ID)).toBe(before);
  });
});
