import type { KeybindingCommand } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

/**
 * The command registry: each owner of a keybinding command registers the
 * function that runs it, and Vim mode's leader keys (`keys/keyEngine.ts`) run
 * commands through it.
 *
 * The owners are the components whose own chord listeners already handle the
 * command (`ChatView`, `CommandPalette`, the sidebar layout, …). Each registers
 * the same function its chord branch calls, so a leader key and a chord have
 * one effect. The chord listeners and the palette rows keep their own
 * dispatch for now (#87).
 *
 * A stack per command rather than one slot: the most recent registration
 * runs, and disposing it restores the previous one. Two owners of one command
 * can be mounted together (the chat route and the pull requests route both
 * own the right panel), and the inner one wins while it is mounted. The same
 * shape as the edge registry in `lib/paneEdges.ts`.
 */

/** An owner's handlers; a command left `undefined` is not registered, so an owner can opt out while it does not apply. */
export type CommandHandlers = {
  readonly [Command in KeybindingCommand]?: (() => void) | undefined;
};

const handlers = new Map<KeybindingCommand, Array<() => void>>();

/** Registers every handler in the map; the returned function removes them all. */
export function registerCommandHandlers(entries: CommandHandlers): () => void {
  const registered: Array<readonly [KeybindingCommand, () => void]> = [];
  for (const [command, run] of Object.entries(entries) as Array<
    [KeybindingCommand, (() => void) | undefined]
  >) {
    if (run === undefined) continue;
    // Each registration gets its own entry, so disposing removes exactly it
    // even when one function is registered twice.
    const entry = () => run();
    const stack = handlers.get(command) ?? [];
    stack.push(entry);
    handlers.set(command, stack);
    registered.push([command, entry]);
  }
  return () => {
    for (const [command, entry] of registered) {
      const stack = handlers.get(command);
      if (!stack) continue;
      const index = stack.lastIndexOf(entry);
      if (index !== -1) stack.splice(index, 1);
      if (stack.length === 0) handlers.delete(command);
    }
  };
}

/** Runs the command's current handler; false when no owner has registered one. */
export function runRegisteredCommand(command: KeybindingCommand): boolean {
  const run = handlers.get(command)?.at(-1);
  if (run === undefined) return false;
  run();
  return true;
}

/**
 * Registers a component's handlers while it is mounted. The callbacks are read
 * through a ref, so the owner may pass fresh closures on every render; the
 * registration changes only when the set of commands does.
 */
export function useCommandHandlers(entries: CommandHandlers): void {
  const latest = useRef(entries);
  useLayoutEffect(() => {
    latest.current = entries;
  });
  const commandsKey = (Object.keys(entries) as KeybindingCommand[])
    .filter((command) => entries[command] !== undefined)
    .sort()
    .join(" ");

  const stable = useMemo(() => {
    const commands = commandsKey === "" ? [] : (commandsKey.split(" ") as KeybindingCommand[]);
    return Object.fromEntries(
      commands.map((command) => [command, () => latest.current[command]?.()]),
    ) as CommandHandlers;
  }, [commandsKey]);

  useEffect(() => registerCommandHandlers(stable), [stable]);
}
