import { RegistryContext } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { startTransition, useContext, useEffect, useState } from "react";

/**
 * Unlike `useAtomValue`, which renders each update synchronously, a transition yields to
 * input, so a typed key's render goes first. Priority only: when updates are published is
 * the atom's to decide (see `throttledAtom`).
 */
export function useAtomValueInTransition<A>(atom: Atom.Atom<A>): A {
  const registry = useContext(RegistryContext);
  const [value, setValue] = useState(() => registry.get(atom));
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to the atom registry so each update can be wrapped in startTransition
  useEffect(
    () =>
      registry.subscribe(atom, (next) => startTransition(() => setValue(() => next)), {
        immediate: true,
      }),
    [registry, atom],
  );
  return value;
}
