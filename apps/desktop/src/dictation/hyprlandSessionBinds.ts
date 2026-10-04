// @effect-diagnostics nodeBuiltinImport:off -- `hyprctl` is a native compositor boundary, as in CaptureShortcutConfig.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import type { DictationKeybindingCommand } from "@t3tools/contracts";

import { DICTATION_FLAG, dictationCommandLineArguments } from "./dictationCommandLine.ts";

/**
 * The dictation keys, bound in Hyprland only while a dictation session exists, so they reach
 * Mesura while another app has focus and stay free the rest of the time. Each key launches the
 * desktop binary with `--dictation …`, which the running instance takes over.
 *
 * Every bind is preceded by its unbind: an instance that crashed mid-session leaves its binds
 * behind, and a second `bind` would add a duplicate instead of replacing it.
 *
 * Binds that already sit on these combos (Symmetria Shell keeps Alt+Space and Alt+X; the user's
 * config may bind others) are read at session start and put back at session end, because a
 * plain unbind deletes them until the next Hyprland reload.
 */
const SESSION_KEYS: ReadonlyArray<readonly [key: string, command: DictationKeybindingCommand]> = [
  ["S", "dictation.mode.clipboard"],
  ["I", "dictation.mode.inject"],
  ["Return", "dictation.mode.submit"],
  ["space", "dictation.pause"],
  ["R", "dictation.restart"],
  ["X", "dictation.cancel"],
];

/** Hyprland's modmask for Alt alone. */
const ALT_MODMASK = 8;

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** Hyprland runs `exec` through `sh -c`. */
function shellQuote(argument: string): string {
  return SHELL_SAFE.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}

/** A bind `hyprctl -j binds` reported on one of the session combos, as far as it can be re-added. */
interface SavedBind {
  /** The key exactly as Hyprland reports it: `unbind` matches key names case-sensitively. */
  readonly key: string;
  /** The `bind` flag letters, `d` included when the bind has a description. */
  readonly flags: string;
  readonly description: string | null;
  readonly dispatcher: string;
  readonly arg: string;
}

/** `hyprctl -j binds` field → `bind` flag letter, for the flags it reports. */
const BIND_FLAGS: ReadonlyArray<readonly [field: string, letter: string]> = [
  ["locked", "l"],
  ["release", "r"],
  ["longPress", "o"],
  ["repeat", "e"],
  ["non_consuming", "n"],
  ["mouse", "m"],
];

const SESSION_KEY_NAMES = new Set(SESSION_KEYS.map(([key]) => key.toLowerCase()));

/** An earlier instance's own bind, left behind by a crash; never restored. */
const isOwnBind = (arg: string) => arg.split(/\s+/).includes(DICTATION_FLAG);

/** The binds on the session combos, from `hyprctl -j binds`; throws on output it cannot read. */
export function parseSessionComboBinds(json: string): ReadonlyArray<SavedBind> {
  const binds: unknown = JSON.parse(json);
  if (!Array.isArray(binds)) throw new Error("hyprctl binds did not return a list.");
  return binds.flatMap((raw: unknown): SavedBind[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const bind = raw as Record<string, unknown>;
    const { key, dispatcher, arg } = bind;
    if (bind.modmask !== ALT_MODMASK || (bind.submap ?? "") !== "") return [];
    if (typeof key !== "string" || !SESSION_KEY_NAMES.has(key.toLowerCase())) return [];
    if (typeof dispatcher !== "string" || typeof arg !== "string" || isOwnBind(arg)) return [];
    const description =
      bind.has_description === true && typeof bind.description === "string"
        ? bind.description
        : null;
    const flags =
      BIND_FLAGS.filter(([field]) => bind[field] === true)
        .map(([, letter]) => letter)
        .join("") + (description === null ? "" : "d");
    return [{ key, flags, description, dispatcher, arg }];
  });
}

/**
 * One `hyprctl keyword` command. `--batch` splits its input on `;`, and shell quoting does not
 * protect it, so a command that carries text from the user's config (a restored bind) or any
 * `;` runs as its own `hyprctl keyword` call with an argument vector instead.
 */
interface KeywordCommand {
  readonly keyword: string;
  readonly value: string;
  readonly userText: boolean;
}

const generated = (keyword: string, value: string): KeywordCommand => ({
  keyword,
  value,
  userText: false,
});

function bindCommands(
  launcher: ReadonlyArray<string>,
  saved: ReadonlyArray<SavedBind>,
): ReadonlyArray<KeywordCommand> {
  return SESSION_KEYS.flatMap(([key, command]) => {
    // A saved bind spelled in another case is a separate key name to `unbind`.
    const otherSpellings = [
      ...new Set(
        saved
          .map((bind) => bind.key)
          .filter((name) => name !== key && name.toLowerCase() === key.toLowerCase()),
      ),
    ];
    return [
      generated("unbind", `ALT,${key}`),
      ...otherSpellings.map((name) => generated("unbind", `ALT,${name}`)),
      generated(
        "bind",
        `ALT,${key},exec,${[...launcher, ...dictationCommandLineArguments(command)]
          .map(shellQuote)
          .join(" ")}`,
      ),
    ];
  });
}

function unbindCommands(saved: ReadonlyArray<SavedBind>): ReadonlyArray<KeywordCommand> {
  return [
    ...SESSION_KEYS.map(([key]) => generated("unbind", `ALT,${key}`)),
    ...saved.map((bind) => ({
      keyword: `bind${bind.flags}`,
      value: `ALT,${bind.key},${bind.description === null ? "" : `${bind.description},`}${
        bind.dispatcher
      },${bind.arg}`,
      userText: true,
    })),
  ];
}

/** Runs `commands` in order: plain generated ones in batches, the rest one call each. */
async function runKeywordCommands(
  execute: HyprctlExecute,
  commands: ReadonlyArray<KeywordCommand>,
): Promise<void> {
  let batch: KeywordCommand[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const lines = batch.map((command) => `keyword ${command.keyword} ${command.value}`);
    batch = [];
    await execute("hyprctl", ["--batch", lines.join(" ; ")]);
  };
  for (const command of commands) {
    if (command.userText || command.value.includes(";")) {
      await flush();
      await execute("hyprctl", ["keyword", command.keyword, command.value]);
    } else {
      batch.push(command);
    }
  }
  await flush();
}

export type HyprctlExecute = (
  file: string,
  args: ReadonlyArray<string>,
) => Promise<{ readonly stdout: string } | undefined>;

export const executeHyprctl: HyprctlExecute = (file, args) =>
  NodeUtil.promisify(NodeChildProcess.execFile)(file, [...args], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });

export function createHyprlandSessionBinds(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly launcher: ReadonlyArray<string>;
  readonly execute: HyprctlExecute;
  readonly onError?: (cause: unknown) => void;
}): {
  readonly setSessionActive: (active: boolean) => Promise<void>;
  readonly dispose: () => Promise<void>;
} {
  const enabled = Boolean(input.env.HYPRLAND_INSTANCE_SIGNATURE?.trim());
  let bound = false;
  /** What sat on the session combos before this session bound them. */
  let saved: ReadonlyArray<SavedBind> = [];
  // Serialized, so a quick start and end cannot reach Hyprland out of order.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => {
    queue = queue.then(step).catch((cause: unknown) => input.onError?.(cause));
    return queue;
  };

  const bind = async () => {
    try {
      const output = await input.execute("hyprctl", ["-j", "binds"]);
      saved = parseSessionComboBinds(output?.stdout ?? "");
    } catch (cause) {
      // Bind anyway: the keys matter more than restoring what they covered.
      saved = [];
      input.onError?.(cause);
    }
    await runKeywordCommands(input.execute, bindCommands(input.launcher, saved));
  };

  const unbind = async () => {
    const restore = saved;
    saved = [];
    await runKeywordCommands(input.execute, unbindCommands(restore));
  };

  const setSessionActive = (active: boolean): Promise<void> => {
    if (!enabled || active === bound) return queue;
    bound = active;
    return enqueue(active ? bind : unbind);
  };

  return { setSessionActive, dispose: () => setSessionActive(false) };
}
