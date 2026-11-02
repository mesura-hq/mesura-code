import type { KeybindingCommand } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import {
  registerCommands,
  type CommandHandlers as ChordHandlers,
  type CommandScopeOptions,
} from "~/shortcuts/dispatcher";

/**
 * Owners register the function their chord branch already calls, so a Vim leader key and a chord
 * run one effect. A stack per command: two owners can be mounted together (chat and pull requests
 * both own the right panel), the newest wins, and disposing it restores the previous one.
 */

/** Returning `false` declines: the command does not apply right now. */
type CommandHandler = () => boolean | void;

/** An owner's handlers; a command left `undefined` is not registered, so an owner can opt out while it does not apply. */
export type CommandHandlers = {
  readonly [Command in KeybindingCommand]?: CommandHandler | undefined;
};

const handlers = new Map<KeybindingCommand, Array<CommandHandler>>();

/** Registers every handler in the map; the returned function removes them all. */
export function registerCommandHandlers(entries: CommandHandlers): () => void {
  const registered: Array<readonly [KeybindingCommand, CommandHandler]> = [];
  for (const [command, run] of Object.entries(entries) as Array<
    [KeybindingCommand, CommandHandler | undefined]
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

/** Runs the command's current handler; false when no owner has registered one or it declined. */
export function runRegisteredCommand(command: KeybindingCommand): boolean {
  const run = handlers.get(command)?.at(-1);
  if (run === undefined) return false;
  return run() !== false;
}

/**
 * Registers a chord scope (`shortcuts/dispatcher`) and gives every one of its
 * commands to this registry too, so a leader key runs the chord's handler
 * under the scope's own guard. The handler receives a keydown nobody dispatched,
 * so its `preventDefault` reaches no real event.
 */
export function registerCommandsWithLeaderKeys(
  commands: ChordHandlers,
  options: CommandScopeOptions = {},
): () => void {
  const unregisterChords = registerCommands(commands, options);
  const leaderHandlers: CommandHandlers = Object.fromEntries(
    Object.entries(commands).flatMap(([command, handler]) =>
      handler === undefined
        ? []
        : [
            [
              command,
              () => {
                const event = new KeyboardEvent("keydown");
                if (options.when && !options.when(event)) return false;
                return handler(event) !== false;
              },
            ],
          ],
    ),
  );
  const unregisterLeaderKeys = registerCommandHandlers(leaderHandlers);
  return () => {
    unregisterLeaderKeys();
    unregisterChords();
  };
}

/**
 * Registers a component's handlers while it is mounted. The callbacks are read
 * through a ref, so the owner may pass fresh closures on every render; the
 * registration changes only when the set of commands does.
 */
export function useCommandHandlers(entries: CommandHandlers): void {
  const latest = useRef(entries);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- latest-ref: the registered closures read the newest handlers without re-registering
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers in the module-level registry while mounted; cleanup unregisters
  useEffect(() => registerCommandHandlers(stable), [stable]);
}
