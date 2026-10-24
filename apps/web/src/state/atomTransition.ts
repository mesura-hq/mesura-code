import { RegistryContext } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { startTransition, useContext, useEffect, useState } from "react";

/**
 * An atom's value whose updates render as a React transition. `useAtomValue`
 * renders each update synchronously, inside whatever task set the atom; a
 * transition renders in slices that yield to input, and an urgent render such
 * as a typed key's goes first. Priority only: when updates are published is
 * the atom's to decide (see `throttledAtom`).
 */
export function useAtomValueInTransition<A>(atom: Atom.Atom<A>): A {
  const registry = useContext(RegistryContext);
  const [value, setValue] = useState(() => registry.get(atom));
  useEffect(
    () =>
      registry.subscribe(atom, (next) => startTransition(() => setValue(() => next)), {
        immediate: true,
      }),
    [registry, atom],
  );
  return value;
}
