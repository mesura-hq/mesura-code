import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SnoozePreset } from "../Sidebar.snooze";

type SnoozeChoice = Pick<SnoozePreset, "snoozedUntil">;
type SnoozeAndAdvance = (target: ScopedThreadRef, choice: SnoozeChoice) => void;

let mountedSnooze: SnoozeAndAdvance | null = null;
const pending = new Map<string, { target: ScopedThreadRef; choice: SnoozeChoice }>();

/** The phone drawer mounts the row owner only after a command reveals it. */
export function registerSnoozeAndAdvance(handler: SnoozeAndAdvance): () => void {
  mountedSnooze = handler;
  const requests = [...pending.values()];
  pending.clear();
  for (const { target, choice } of requests) handler(target, choice);
  return () => {
    if (mountedSnooze === handler) mountedSnooze = null;
  };
}

/** Returns false when the caller must reveal the drawer to serve the queued pick. */
export function snoozeAndAdvance(target: ScopedThreadRef, choice: SnoozeChoice): boolean {
  if (mountedSnooze) {
    mountedSnooze(target, choice);
    return true;
  }
  pending.set(scopedThreadKey(target), { target, choice });
  return false;
}

export function cancelPendingSnoozes(): void {
  pending.clear();
}
