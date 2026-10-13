import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";

/** The phone request is independent of desktop dock pins and survives a closing sidebar portal. */
export const hostsSheetOpenAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("hosts-sheet:open"),
);
export const requestHostsSheet = () => appAtomRegistry.set(hostsSheetOpenAtom, true);
export const closeHostsSheet = () => appAtomRegistry.set(hostsSheetOpenAtom, false);
