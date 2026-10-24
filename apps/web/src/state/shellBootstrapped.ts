import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentShell } from "./shell";

// Mesura: whether an environment's shell snapshot has arrived, as its own atom.
// The shell state changes on every streamed shell update; a view that only
// needs this flag and reads the whole state re-renders with each of them —
// the thread route re-rendered the whole chat view per background update
// (phase 6 of the editor latency cycle).
const environmentShellBootstrappedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot),
  ).pipe(Atom.withLabel(`web-environment-shell-bootstrapped:${environmentId}`)),
);

const NOT_BOOTSTRAPPED_ATOM = Atom.make(false).pipe(
  Atom.withLabel("web-environment-shell-bootstrapped:none"),
);

export function useEnvironmentShellBootstrapped(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? NOT_BOOTSTRAPPED_ATOM
      : environmentShellBootstrappedAtom(environmentId),
  );
}
