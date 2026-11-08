import { act, render as renderBrowser, type Screen } from "../../test/render";
import { RegistryContext } from "@effect/atom-react";

import { Atom, AtomRegistry } from "effect/reactivity";
import { useSyncExternalStore, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { useAtomValueInTransition } from "./atomTransition";

let container: HTMLDivElement;
let root: Screen;

async function setupBrowserFixture0() {
  container = document.createElement("div");
  document.body.append(container);
  // The transition fixture needs only its isolated atom registry.
  root = await renderBrowser(null, { container, router: false });

  return {
    async [Symbol.asyncDispose]() {
      await root[Symbol.asyncDispose]();
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

async function mount(registry: AtomRegistry.AtomRegistry, children: ReactNode) {
  await root.rerender(
    <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>,
  );
}

it("shows each value the atom takes", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  const registry = AtomRegistry.make();
  const count = Atom.make(1);
  function View() {
    return <span>{useAtomValueInTransition(count)}</span>;
  }
  await mount(registry, <View />);
  expect(container.textContent).toBe("1");
  await act(() => registry.set(count, 2));
  expect(container.textContent).toBe("2");
});

it("lets an urgent update render before its pending one", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  const registry = AtomRegistry.make();
  const shells = Atom.make("old list");
  // A typed key's state, read the way urgent state is: synchronously.
  let typed = "";
  const typedListeners = new Set<() => void>();
  const typeKey = (text: string) => {
    typed = text;
    for (const listener of typedListeners) listener();
  };
  const subscribeTyped = (listener: () => void) => {
    typedListeners.add(listener);
    return () => {
      typedListeners.delete(listener);
    };
  };
  const seen: string[] = [];
  function View() {
    const key = useSyncExternalStore(subscribeTyped, () => typed);
    const list = useAtomValueInTransition(shells);
    seen.push(`${key}|${list}`);
    return null;
  }
  await mount(registry, <View />);
  seen.length = 0;
  await act(async () => {
    // A background update and a key in the same task: the key renders first,
    // with the list it had, and the list follows.
    registry.set(shells, "new list");
    typeKey("k");
  });
  expect(seen[0]).toBe("k|old list");
  expect(seen.at(-1)).toBe("k|new list");
});
