// @effect-diagnostics nodeBuiltinImport:off -- `hyprctl` is a native compositor boundary, as in CaptureShortcutConfig.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import type { DictationKeybindingCommand } from "@t3tools/contracts";

import { DICTATION_FLAG, dictationCommandLineArguments } from "./dictationCommandLine.ts";
import {
  generatedKeyword,
  isHyprlandSession,
  runKeywordCommands,
  type HyprctlExecute,
  type KeywordCommand,
} from "./hyprctl.ts";

/**
 * The dictation keys, bound in Hyprland only while a dictation session exists, so they reach
 * Mesura while another app has focus and stay free the rest of the time. Each key writes its
 * `--dictation …` words to this instance's command socket through `socat`, or `python3` when
 * `socat` is missing or cannot address the path. With neither, or when the client fails, the
 * key launches the desktop binary with the same words, which the single-instance lock hands to
 * the running instance: that works everywhere, but costs a full Electron start per key press.
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

/** How every generated bind line ends: the launcher's words, alone or as the socket fallback. */
const GENERATED_TAILS = SESSION_KEYS.map(
  ([, command]) => ` ${dictationCommandLineArguments(command).join(" ")}`,
);

/** The session socket's file name, which no user command has reason to carry. */
const SESSION_SOCKET_NAME = /mesura-dictation-\d+\.sock/;

/**
 * An earlier instance's own bind, left behind by a crash; never restored. Recognised by the
 * shape this module generates, not by any mention of the flag: a user command that merely
 * quotes the dictation words is the user's. A user bind that runs `… --dictation cancel` itself
 * cannot be told from ours, as before the socket existed.
 */
const isOwnBind = (arg: string) =>
  GENERATED_TAILS.some((tail) => arg.endsWith(tail)) ||
  (SESSION_SOCKET_NAME.test(arg) && arg.includes(DICTATION_FLAG));

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
 * How a key reaches the running instance, chosen once per session. A socket client runs by the
 * absolute path found on this process's PATH: Hyprland runs binds with its own PATH, and this
 * process's PATH has been extended from the login shell (`DesktopShellEnvironment`).
 */
type BindTransport =
  | { readonly tool: "socat" | "python3"; readonly executable: string }
  | { readonly tool: "launcher" };

const SOCKET_CLIENTS = ["socat", "python3"] as const;

/**
 * Paths socat's address grammar reads as written: it splits addresses at `,` and `:` and
 * gives quotes and `!!` meanings of their own. Any other path goes through python3.
 */
const SOCAT_SAFE_PATH = /^[\w./-]+$/;

/**
 * Writes `argv[2:]` as one line to the socket at `argv[1]`. One expression, because a `;`
 * would make the bind leave the `hyprctl --batch` call.
 */
const PYTHON_CLIENT =
  '(lambda m,a:(lambda s:(s.connect(a[1]),s.sendall((" ".join(a[2:])+"\\n").encode())))' +
  '(m.socket(m.AF_UNIX)))(__import__("socket"),__import__("sys").argv)';

interface BindTarget {
  readonly transport: BindTransport;
  readonly launcher: ReadonlyArray<string>;
  readonly socketPath: string;
}

/**
 * The shell line a key runs. A socket client that fails (the socket is gone, the client cannot
 * start) falls back to the launcher, so a key never does nothing.
 */
function execLine(target: BindTarget, command: DictationKeybindingCommand): string {
  const words = dictationCommandLineArguments(command);
  const launch = [...target.launcher, ...words].map(shellQuote).join(" ");
  const { transport } = target;
  switch (transport.tool) {
    case "socat":
      return `printf ${shellQuote("%s\\n")} ${shellQuote(words.join(" "))} | ${shellQuote(
        transport.executable,
      )} - ${shellQuote(`UNIX-CONNECT:${target.socketPath}`)} || ${launch}`;
    case "python3":
      return `${[transport.executable, "-c", PYTHON_CLIENT, target.socketPath, ...words]
        .map(shellQuote)
        .join(" ")} || ${launch}`;
    case "launcher":
      return launch;
  }
}

function bindCommands(
  target: BindTarget,
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
      generatedKeyword("unbind", `ALT,${key}`),
      ...otherSpellings.map((name) => generatedKeyword("unbind", `ALT,${name}`)),
      generatedKeyword("bind", `ALT,${key},exec,${execLine(target, command)}`),
    ];
  });
}

function unbindCommands(saved: ReadonlyArray<SavedBind>): ReadonlyArray<KeywordCommand> {
  return [
    ...SESSION_KEYS.map(([key]) => generatedKeyword("unbind", `ALT,${key}`)),
    ...saved.map((bind) => ({
      keyword: `bind${bind.flags}`,
      value: `ALT,${bind.key},${bind.description === null ? "" : `${bind.description},`}${
        bind.dispatcher
      },${bind.arg}`,
      userText: true,
    })),
  ];
}

/** The absolute path `name` resolves to on this process's PATH, or null. */
export const resolveCommandPath = async (name: string): Promise<string | null> => {
  try {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "sh",
      ["-c", 'command -v "$1"', "sh", name],
      { timeout: 5_000 },
    );
    const found = stdout.trim();
    // A builtin, alias or function prints a bare name, which Hyprland's shell may not have.
    return found.startsWith("/") ? found : null;
  } catch {
    return null;
  }
};

async function resolveBindTransport(
  socketPath: string,
  resolveCommand: (name: string) => Promise<string | null>,
): Promise<BindTransport> {
  for (const tool of SOCKET_CLIENTS) {
    if (tool === "socat" && !SOCAT_SAFE_PATH.test(socketPath)) continue;
    const executable = await resolveCommand(tool).catch(() => null);
    if (executable !== null) return { tool, executable };
  }
  return { tool: "launcher" };
}

export function createHyprlandSessionBinds(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly launcher: ReadonlyArray<string>;
  /** The command socket the keys write to while it listens. */
  readonly socketPath: string;
  /** The absolute path of a command on the PATH, or null. */
  readonly resolveCommand: (name: string) => Promise<string | null>;
  readonly execute: HyprctlExecute;
  readonly onError?: (cause: unknown) => void;
}): {
  /** Whether this process runs under Hyprland, the only place the binds go. */
  readonly enabled: boolean;
  /** `socketListening: false` keeps the keys on the launcher for this session. */
  readonly setSessionActive: (active: boolean, socketListening?: boolean) => Promise<void>;
  readonly dispose: () => Promise<void>;
} {
  const enabled = isHyprlandSession(input.env);
  let bound = false;
  /** What sat on the session combos before this session bound them. */
  let saved: ReadonlyArray<SavedBind> = [];
  // Serialized, so a quick start and end cannot reach Hyprland out of order.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => {
    queue = queue.then(step).catch((cause: unknown) => input.onError?.(cause));
    return queue;
  };

  const reportRejections = (rejections: ReadonlyArray<string>) => {
    if (rejections.length > 0) input.onError?.(new Error(rejections.join("; ")));
  };

  const bind = async (socketListening: boolean) => {
    const transport: BindTransport = socketListening
      ? await resolveBindTransport(input.socketPath, input.resolveCommand)
      : { tool: "launcher" };
    try {
      const output = await input.execute("hyprctl", ["-j", "binds"]);
      saved = parseSessionComboBinds(output?.stdout ?? "");
    } catch (cause) {
      // Bind anyway: the keys matter more than restoring what they covered.
      saved = [];
      input.onError?.(cause);
    }
    reportRejections(
      await runKeywordCommands(
        input.execute,
        bindCommands({ transport, launcher: input.launcher, socketPath: input.socketPath }, saved),
      ),
    );
  };

  const unbind = async () => {
    const restore = saved;
    saved = [];
    reportRejections(await runKeywordCommands(input.execute, unbindCommands(restore)));
  };

  const setSessionActive = (active: boolean, socketListening = true): Promise<void> => {
    if (!enabled || active === bound) return queue;
    bound = active;
    return enqueue(active ? () => bind(socketListening) : unbind);
  };

  return { enabled, setSessionActive, dispose: () => setSessionActive(false) };
}
