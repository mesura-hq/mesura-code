// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- `hyprctl` is a native compositor boundary, as in CaptureShortcutConfig; the session state changes from IPC callbacks outside any Effect fiber.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import type { DictationKeybindingCommand } from "@t3tools/contracts";

import { DICTATION_FLAG, dictationCommandLineArguments } from "./dictationCommandLine.ts";
import {
  generatedKeyword,
  isHyprlandSession,
  luaString,
  luaTable,
  createHyprlandConfigProviderReader,
  releaseLuaHandles,
  runKeywordCommands,
  runLuaEval,
  type HyprctlExecute,
  type HyprlandConfigProvider,
  type KeywordCommand,
} from "./hyprctl.ts";

/**
 * Bound only while a session exists. Each key writes its `--dictation …` words to the command
 * socket via `socat` or `python3`; failing both, it launches the binary (a full Electron start).
 * Under Hyprlang each bind follows its unbind, and the combos' earlier binds come back at end.
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

/**
 * The binds on the session combos, from `hyprctl -j binds`, and the commands of the ones shaped
 * like this module's, from this process or another; throws on output it cannot read.
 */
function readSessionComboBinds(json: string): {
  readonly saved: ReadonlyArray<SavedBind>;
  readonly generated: ReadonlyArray<string>;
} {
  const binds: unknown = JSON.parse(json);
  if (!Array.isArray(binds)) throw new Error("hyprctl binds did not return a list.");
  const generated: string[] = [];
  const saved = binds.flatMap((raw: unknown): SavedBind[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const bind = raw as Record<string, unknown>;
    const { key, dispatcher, arg } = bind;
    if (bind.modmask !== ALT_MODMASK || (bind.submap ?? "") !== "") return [];
    if (typeof key !== "string" || !SESSION_KEY_NAMES.has(key.toLowerCase())) return [];
    if (typeof dispatcher !== "string" || typeof arg !== "string") return [];
    if (isOwnBind(arg)) {
      generated.push(arg);
      return [];
    }
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
  return { saved, generated };
}

/** The binds on the session combos, from `hyprctl -j binds`; throws on output it cannot read. */
export const parseSessionComboBinds = (json: string): ReadonlyArray<SavedBind> =>
  readSessionComboBinds(json).saved;

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

/**
 * The session's bind handles and owning socket. The operator's Hyprland config reads this name: its
 * recorder binds on Alt+Space and Alt+X do nothing while it is set, so a rename breaks them. The
 * handles sit beside the config's binds, because a Lua callback cannot be unbound and bound again.
 */
const LUA_BINDS_GLOBAL = "__mesura_dictation_binds";

const releaseOwnedBinds = `${releaseLuaHandles(`(_G.${LUA_BINDS_GLOBAL} or {}).handles`, "remove")} _G.${LUA_BINDS_GLOBAL} = nil`;

/**
 * Lua that binds the keys unless a session that started later holds them; the socket path breaks a
 * tie. A reload empties the Lua state and every active session binds again, in any order, so the
 * newest start must win. A clock set back between two starts can reverse that order.
 */
function bindLua(target: BindTarget, startedAt: number): string {
  const binds = SESSION_KEYS.map(
    ([key, command]) =>
      `hl.bind(${luaString(`ALT + ${key}`)}, hl.dsp.exec_cmd(${luaString(
        execLine(target, command),
      )}), ${luaTable([["description", luaString(`Mesura dictation: ${command}`)]])})`,
  );
  const owner = luaString(target.socketPath);
  return `local held = _G.${LUA_BINDS_GLOBAL} if held == nil or held.owner == ${owner} or held.startedAt < ${startedAt} or (held.startedAt == ${startedAt} and held.owner < ${owner}) then ${releaseOwnedBinds} _G.${LUA_BINDS_GLOBAL} = { owner = ${owner}, startedAt = ${startedAt}, handles = { ${binds.join(", ")} } } end`;
}

/** Lua that removes the keys only while this process still owns them: a later session took them. */
const unbindLua = (socketPath: string) =>
  `if (_G.${LUA_BINDS_GLOBAL} or {}).owner == ${luaString(socketPath)} then ${releaseOwnedBinds} end`;

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
  /** Binds again while a session is active: a config reload dropped the runtime binds. */
  readonly reapply: () => Promise<void>;
  readonly dispose: () => Promise<void>;
} {
  const enabled = isHyprlandSession(input.env);
  const readConfigProvider = createHyprlandConfigProviderReader(input.execute);
  /** Whether a session wants the binds; what Hyprland holds can differ after a reload. */
  let active = false;
  let socketListening = true;
  /** How the binds now in Hyprland were sent, so they are removed the same way. */
  let boundWith: HyprlandConfigProvider | null = null;
  /** When the session started; under Lua, a later start takes the keys and keeps them. */
  let startedAt = 0;
  /** The commands of the binds this session sent (Hyprlang only), to tell them from others. */
  let sentLines: ReadonlySet<string> = new Set();
  /** What sat on the session combos before this session bound them (Hyprlang only). */
  let saved: ReadonlyArray<SavedBind> = [];
  // Serialized, so a quick start and end cannot reach Hyprland out of order, and a reload that
  // lands after the session ended binds nothing.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => {
    queue = queue.then(step).catch((cause: unknown) => input.onError?.(cause));
    return queue;
  };

  const throwRejections = (rejections: ReadonlyArray<string>) => {
    if (rejections.length > 0) throw new Error(rejections.join("; "));
  };

  /** The combos' binds as Hyprland reports them now, or null when the read failed. */
  const readComboBinds = async () => {
    try {
      const output = await input.execute("hyprctl", ["-j", "binds"]);
      return readSessionComboBinds(output?.stdout ?? "");
    } catch (cause) {
      input.onError?.(cause);
      return null;
    }
  };

  /** Whether Hyprland still holds a bind this session sent: another process's are not ours. */
  const holdsOwnBinds = (reported: { readonly generated: ReadonlyArray<string> }) =>
    reported.generated.some((arg) => sentLines.has(arg));

  const bindKeywords = async (target: BindTarget, rebinding: boolean) => {
    const reported = await readComboBinds();
    // A first bind always takes the snapshot. A rebind that finds this session's binds still in
    // place keeps it, since no reload brought the config's back; after one, it takes the new one.
    // A failed read keeps any snapshot: the keys matter more than restoring what they covered.
    if (reported !== null && (!rebinding || !holdsOwnBinds(reported))) saved = reported.saved;
    const lines = SESSION_KEYS.map(([, command]) => execLine(target, command));
    // Recorded before sending: Hyprland can apply a batch whose reply then times out, and the
    // end must still know these binds. Earlier lines stay until this batch is confirmed.
    sentLines = new Set([...sentLines, ...lines]);
    throwRejections(await runKeywordCommands(input.execute, bindCommands(target, saved)));
    sentLines = new Set(lines);
  };

  const bind = async () => {
    if (!active) return;
    const transport: BindTransport = socketListening
      ? await resolveBindTransport(input.socketPath, input.resolveCommand)
      : { tool: "launcher" };
    const target = { transport, launcher: input.launcher, socketPath: input.socketPath };
    const provider = await readConfigProvider();
    // A provider switch means a reload, which dropped whatever this session had bound.
    const rebinding = boundWith === provider;
    boundWith = provider;
    if (provider === "lua")
      throwRejections(await runLuaEval(input.execute, bindLua(target, startedAt)));
    else await bindKeywords(target, rebinding);
  };

  /** Cleared only once Hyprland took the removal, so a failed one runs again at the next end. */
  const unbind = async () => {
    if (active || boundWith === null) return;
    if (boundWith === "lua") {
      throwRejections(await runLuaEval(input.execute, unbindLua(input.socketPath)));
    } else {
      // A reload this module missed already put the config's binds back, maybe changed since the
      // snapshot: with none of this session's binds left, there is nothing to undo.
      const reported = await readComboBinds();
      if (reported === null || holdsOwnBinds(reported))
        throwRejections(await runKeywordCommands(input.execute, unbindCommands(saved)));
    }
    boundWith = null;
    saved = [];
    sentLines = new Set();
  };

  const setSessionActive = (next: boolean, listening = true): Promise<void> => {
    // An end with binds still recorded runs again: the last removal failed.
    if (!enabled || (next === active && (next || boundWith === null))) return queue;
    active = next;
    if (next) {
      socketListening = listening;
      startedAt = Date.now();
    }
    return enqueue(next ? bind : unbind);
  };

  const reapply = () => (enabled ? enqueue(bind) : queue);

  return { enabled, setSessionActive, reapply, dispose: () => setSessionActive(false) };
}
