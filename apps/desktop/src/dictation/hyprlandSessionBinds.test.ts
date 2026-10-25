// @effect-diagnostics nodeBuiltinImport:off - the rework specs run the generated bind lines
// through `/bin/sh` against a real Unix socket, as Hyprland would.
/**
 * Entry point: `createHyprlandSessionBinds`, which the desktop main process
 * drives from the renderer's dictation state and from app quit, with the
 * `hyprctl` execution injected the way `snapShot/CaptureShortcutConfig.ts`
 * injects its own.
 *
 * STT redesign, phase 6, criterion 5. Search unification, phase 4, criteria 4 and 5: the
 * socket client each key runs, with the PATH lookup injected as `resolveCommand`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { createHyprlandSessionBinds } from "./hyprlandSessionBinds.ts";

const HYPRLAND = { HYPRLAND_INSTANCE_SIGNATURE: "fence_1759492800_123456" };
const LAUNCHER = ["/usr/bin/mesura-code"];

const BIND_BATCH = [
  "keyword unbind ALT,S",
  "keyword bind ALT,S,exec,/usr/bin/mesura-code --dictation mode clipboard",
  "keyword unbind ALT,I",
  "keyword bind ALT,I,exec,/usr/bin/mesura-code --dictation mode inject",
  "keyword unbind ALT,Return",
  "keyword bind ALT,Return,exec,/usr/bin/mesura-code --dictation mode submit",
  "keyword unbind ALT,space",
  "keyword bind ALT,space,exec,/usr/bin/mesura-code --dictation pause",
  "keyword unbind ALT,R",
  "keyword bind ALT,R,exec,/usr/bin/mesura-code --dictation restart",
  "keyword unbind ALT,X",
  "keyword bind ALT,X,exec,/usr/bin/mesura-code --dictation cancel",
].join(" ; ");

const UNBIND_BATCH = [
  "keyword unbind ALT,S",
  "keyword unbind ALT,I",
  "keyword unbind ALT,Return",
  "keyword unbind ALT,space",
  "keyword unbind ALT,R",
  "keyword unbind ALT,X",
].join(" ; ");

const READ_BINDS = ["hyprctl", ["-j", "binds"]];

const SOCKET_PATH = "/run/user/1000/mesura-dictation-4242.sock";

/**
 * `existing` is what `hyprctl -j binds` reports; an Error makes the read fail. `tools` are the
 * socket clients on the PATH Hyprland runs binds with; none keeps today's relaunch.
 */
function makeBinds(
  env: Record<string, string | undefined>,
  launcher = LAUNCHER,
  existing: ReadonlyArray<Record<string, unknown>> | Error = [],
  tools: ReadonlyArray<string> = [],
  socketPath = SOCKET_PATH,
  toolPath: (name: string) => string = (name) => `/usr/bin/${name}`,
) {
  const execute = vi.fn(async (_file: string, args: ReadonlyArray<string>) => {
    if (args[0] !== "-j") return undefined;
    if (existing instanceof Error) throw existing;
    return { stdout: JSON.stringify(existing) };
  });
  const onError = vi.fn();
  const resolveCommand = vi.fn(async (name: string) =>
    tools.includes(name) ? toolPath(name) : null,
  );
  const binds = createHyprlandSessionBinds({
    env,
    launcher,
    socketPath,
    resolveCommand,
    execute,
    onError,
  });
  const batches = () =>
    execute.mock.calls.filter(([, args]) => args[0] === "--batch").map(([, args]) => args[1]);
  /** Every write to Hyprland in order: a batch as its string, a single keyword as its vector. */
  const writes = () =>
    execute.mock.calls
      .filter(([, args]) => args[0] !== "-j")
      .map(([, args]) => (args[0] === "--batch" ? args[1]! : [...args]));
  /** The `bind` value Hyprland received for `key`, from a batch or a single call. */
  const bindValue = (key: string) => {
    const values = writes().flatMap((write) =>
      typeof write === "string"
        ? write
            .split(" ; ")
            .filter((line) => line.startsWith("keyword bind "))
            .map((line) => line.slice("keyword bind ".length))
        : write[1] === "bind"
          ? [write[2]!]
          : [],
    );
    return values.find((value) => value.startsWith(`ALT,${key},exec,`));
  };
  return { binds, execute, batches, writes, onError, resolveCommand, bindValue };
}

/** A bind as `hyprctl -j binds` reports it on Hyprland 0.56.2. */
function reportedBind(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    locked: false,
    mouse: false,
    release: false,
    repeat: false,
    longPress: false,
    non_consuming: false,
    auto_consuming: false,
    has_description: false,
    modmask: 8,
    submap: "",
    submap_universal: "false",
    keycode: 0,
    catch_all: false,
    description: "",
    allow_input_capture: false,
    dispatcher: "exec",
    ...fields,
  };
}

describe("dictation phase 6 fence: Hyprland session binds", () => {
  it("dictation phase 6 AC5: a session start issues one hyprctl batch that unbinds then binds the six Alt keys", async () => {
    const { binds, execute } = makeBinds(HYPRLAND);
    await binds.setSessionActive(true);
    expect(execute.mock.calls).toEqual([READ_BINDS, ["hyprctl", ["--batch", BIND_BATCH]]]);
  });

  it("dictation phase 6 AC5: a session that is already bound is not bound a second time", async () => {
    const { binds, execute } = makeBinds(HYPRLAND);
    await binds.setSessionActive(true);
    await binds.setSessionActive(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("dictation phase 6 AC5: a session end unbinds the six Alt keys", async () => {
    const { binds, execute } = makeBinds(HYPRLAND);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(execute.mock.calls.at(-1)).toEqual(["hyprctl", ["--batch", UNBIND_BATCH]]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("dictation phase 6 AC5: app quit during a session unbinds the six Alt keys", async () => {
    const { binds, execute } = makeBinds(HYPRLAND);
    await binds.setSessionActive(true);
    await binds.dispose();
    expect(execute.mock.calls.at(-1)).toEqual(["hyprctl", ["--batch", UNBIND_BATCH]]);
  });

  it("dictation phase 6 AC5: a launcher path with a space is quoted for the shell Hyprland execs through", async () => {
    const { binds, batches } = makeBinds(HYPRLAND, ["/opt/Mesura Code/mesura-code"]);
    await binds.setSessionActive(true);
    const batch = batches()[0]!;
    expect(batch).toContain(
      "keyword bind ALT,S,exec,'/opt/Mesura Code/mesura-code' --dictation mode clipboard",
    );
  });

  it("dictation phase 6 AC5: a development launcher keeps its app path before the flag", async () => {
    const { binds, batches } = makeBinds(HYPRLAND, [
      "/repo/node_modules/electron/dist/electron",
      "/repo/apps/desktop",
    ]);
    await binds.setSessionActive(true);
    const batch = batches()[0]!;
    expect(batch).toContain(
      "keyword bind ALT,X,exec,/repo/node_modules/electron/dist/electron /repo/apps/desktop --dictation cancel",
    );
  });

  it("dictation phase 6 guard: outside Hyprland nothing is executed", async () => {
    const { binds, execute } = makeBinds({});
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    await binds.setSessionActive(true);
    await binds.dispose();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("dictation phase 6 fence: Hyprland binds that existed before the session", () => {
  const SHELL_PAUSE = "qs ipc --pid 4242 call recorder pause";

  it("dictation phase 6 AC5: a described bind on a session combo is put back with bindd at session end", async () => {
    const { binds, writes } = makeBinds(HYPRLAND, LAUNCHER, [
      reportedBind({
        key: "space",
        has_description: true,
        description: "Pause/Resume recording",
        arg: SHELL_PAUSE,
      }),
    ]);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(writes()).toEqual([
      BIND_BATCH,
      UNBIND_BATCH,
      ["keyword", "bindd", `ALT,space,Pause/Resume recording,exec,${SHELL_PAUSE}`],
    ]);
  });

  it("dictation phase 6 AC5: a plain bind keeps its flags and its own key spelling when it is put back", async () => {
    const { binds, batches, writes } = makeBinds(HYPRLAND, LAUNCHER, [
      reportedBind({ key: "x", locked: true, repeat: true, arg: "notify-send cancelled" }),
    ]);
    await binds.setSessionActive(true);
    await binds.dispose();
    // `unbind` matches key names case-sensitively, so the lower-case spelling is unbound too.
    expect(batches()[0]).toBe(
      BIND_BATCH.replace("keyword unbind ALT,X ;", "keyword unbind ALT,X ; keyword unbind ALT,x ;"),
    );
    expect(writes().slice(1)).toEqual([
      UNBIND_BATCH,
      ["keyword", "bindle", "ALT,x,exec,notify-send cancelled"],
    ]);
  });

  it("dictation phase 6 AC5: a bind an earlier Mesura left behind and binds on other combos are not put back", async () => {
    const { binds, batches } = makeBinds(HYPRLAND, LAUNCHER, [
      reportedBind({ key: "S", arg: "/usr/bin/mesura-code --dictation mode clipboard" }),
      reportedBind({ key: "V", arg: "qs ipc call stt paste" }),
      reportedBind({ key: "space", modmask: 9, arg: "notify-send shifted" }),
    ]);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(batches()).toEqual([BIND_BATCH, UNBIND_BATCH]);
  });

  it("dictation phase 6 AC5: when the binds cannot be read the keys are still bound and nothing is put back", async () => {
    const failure = new Error("hyprctl: socket timed out");
    const { binds, batches, onError } = makeBinds(HYPRLAND, LAUNCHER, failure);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(batches()).toEqual([BIND_BATCH, UNBIND_BATCH]);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe("dictation phase 6 rework: restored binds that carry semicolons", () => {
  it("dictation phase 6 rework: a semicolon in a restored description reaches Hyprland whole", async () => {
    const { binds, writes } = makeBinds(HYPRLAND, LAUNCHER, [
      reportedBind({
        key: "space",
        has_description: true,
        description: "Pause; resume",
        arg: "qs ipc call recorder pause",
      }),
    ]);
    await binds.setSessionActive(true);
    await binds.dispose();
    expect(writes().at(-1)).toEqual([
      "keyword",
      "bindd",
      "ALT,space,Pause; resume,exec,qs ipc call recorder pause",
    ]);
    // Never through `--batch`, which would split it at the semicolon.
    expect(
      writes().filter((write) => typeof write === "string" && write.includes("Pause;")),
    ).toEqual([]);
  });

  it("dictation phase 6 rework: a semicolon in a restored argument reaches Hyprland whole, after the unbinds", async () => {
    const { binds, writes } = makeBinds(HYPRLAND, LAUNCHER, [
      reportedBind({ key: "X", arg: "printf first; printf second" }),
    ]);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(writes().slice(1)).toEqual([
      UNBIND_BATCH,
      ["keyword", "bind", "ALT,X,exec,printf first; printf second"],
    ]);
  });

  it("dictation phase 6 rework: a launcher path with a semicolon binds its key on its own call, in order", async () => {
    const { binds, writes } = makeBinds(HYPRLAND, ["/opt/odd;dir/mesura-code"]);
    await binds.setSessionActive(true);
    const [first, second, third] = writes();
    expect(first).toBe("keyword unbind ALT,S");
    expect(second).toEqual([
      "keyword",
      "bind",
      "ALT,S,exec,'/opt/odd;dir/mesura-code' --dictation mode clipboard",
    ]);
    expect(third).toBe("keyword unbind ALT,I");
  });
});

describe("search unification phase 4 fence: session binds reach the app over the socket", () => {
  const KEY_WORDS: ReadonlyArray<readonly [key: string, words: string]> = [
    ["S", "--dictation mode clipboard"],
    ["I", "--dictation mode inject"],
    ["Return", "--dictation mode submit"],
    ["space", "--dictation pause"],
    ["R", "--dictation restart"],
    ["X", "--dictation cancel"],
  ];

  it("search unification phase 4 AC4: with socat on the PATH every key runs a socat client against the socket", async () => {
    const { binds, bindValue } = makeBinds(HYPRLAND, LAUNCHER, [], ["socat", "python3"]);
    await binds.setSessionActive(true);
    for (const [key, words] of KEY_WORDS) {
      const value = bindValue(key);
      expect(value, `Alt+${key}`).toContain(`/usr/bin/socat - UNIX-CONNECT:${SOCKET_PATH}`);
      expect(value, `Alt+${key}`).toContain(words);
      // The launcher runs only when the client fails.
      expect(value, `Alt+${key}`).toMatch(new RegExp(` \\|\\| ${LAUNCHER[0]} ${words}$`));
    }
  });

  it("search unification phase 4 AC4: without socat but with python3 every key runs a python3 client against the socket", async () => {
    const { binds, bindValue } = makeBinds(HYPRLAND, LAUNCHER, [], ["python3"]);
    await binds.setSessionActive(true);
    for (const [key, words] of KEY_WORDS) {
      const value = bindValue(key);
      expect(value, `Alt+${key}`).toMatch(/^ALT,\w+,exec,\/usr\/bin\/python3 -c /);
      expect(value, `Alt+${key}`).toContain(` ${SOCKET_PATH} ${words} || `);
      expect(value, `Alt+${key}`).not.toContain("socat");
      expect(value, `Alt+${key}`).toMatch(new RegExp(` \\|\\| ${LAUNCHER[0]} ${words}$`));
    }
  });

  it("search unification phase 4 guard: with neither socat nor python3 the keys keep today's launcher line", async () => {
    const { binds, batches } = makeBinds(HYPRLAND, LAUNCHER, [], []);
    await binds.setSessionActive(true);
    expect(batches()).toEqual([BIND_BATCH]);
  });

  it("search unification phase 4 AC4: the client is chosen once, when a session installs the binds", async () => {
    const { binds, resolveCommand } = makeBinds(HYPRLAND, LAUNCHER, [], ["python3"]);
    expect(resolveCommand).not.toHaveBeenCalled();
    await binds.setSessionActive(true);
    const probed = resolveCommand.mock.calls.map(([name]) => name);
    expect(probed).toContain("socat");
    expect(probed).toContain("python3");
    // Once per install, not once per key.
    expect(probed.length).toBeLessThanOrEqual(2);
    await binds.setSessionActive(false);
    expect(resolveCommand).toHaveBeenCalledTimes(probed.length);
  });

  it("search unification phase 4 AC4: a socket path with a space is quoted for the shell", async () => {
    const socketPath = "/tmp/Mesura Runtime/mesura-dictation-4242.sock";
    const { binds, bindValue } = makeBinds(
      HYPRLAND,
      LAUNCHER,
      [],
      ["socat", "python3"],
      socketPath,
    );
    await binds.setSessionActive(true);
    // socat's address grammar is not the shell's, so such a path goes through python3.
    expect(bindValue("I")).toContain(` '${socketPath}' --dictation mode inject || `);
  });

  it("search unification phase 4 AC5 guard: socket binds still unbind each key before binding it, and the session end restores what they covered", async () => {
    const SHELL_PAUSE = "qs ipc --pid 4242 call recorder pause";
    const { binds, writes } = makeBinds(
      HYPRLAND,
      LAUNCHER,
      [
        reportedBind({
          key: "space",
          has_description: true,
          description: "Pause/Resume recording",
          arg: SHELL_PAUSE,
        }),
      ],
      ["socat"],
    );
    await binds.setSessionActive(true);
    const lines = writes().flatMap((write) =>
      typeof write === "string" ? write.split(" ; ") : [write.join(" ")],
    );
    for (const [key] of KEY_WORDS) {
      const unbindAt = lines.indexOf(`keyword unbind ALT,${key}`);
      const bindAt = lines.findIndex((line) => line.startsWith(`keyword bind ALT,${key},exec,`));
      expect(unbindAt, `Alt+${key} is unbound`).toBeGreaterThanOrEqual(0);
      expect(bindAt, `Alt+${key} is bound`).toBeGreaterThan(unbindAt);
    }

    const before = writes().length;
    await binds.setSessionActive(false);
    expect(writes().slice(before)).toEqual([
      UNBIND_BATCH,
      ["keyword", "bindd", `ALT,space,Pause/Resume recording,exec,${SHELL_PAUSE}`],
    ]);
  });

  it("search unification phase 4 AC5: a socket-client bind an earlier Mesura left behind is not put back", async () => {
    const leftBehind = (words: string) =>
      `printf '%s\\n' '${words}' | socat - UNIX-CONNECT:/run/user/1000/mesura-dictation-99.sock`;
    const { binds, writes } = makeBinds(
      HYPRLAND,
      LAUNCHER,
      [
        reportedBind({ key: "S", arg: leftBehind("--dictation mode clipboard") }),
        reportedBind({
          key: "X",
          arg: "python3 -c 'import sys' /run/user/1000/mesura-dictation-99.sock --dictation cancel",
        }),
      ],
      [],
    );
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(writes()).toEqual([BIND_BATCH, UNBIND_BATCH]);
  });
});

/** The absolute path of `name` on this test host's PATH, or null. */
function hostCommand(name: string): string | null {
  try {
    const found = NodeChildProcess.execFileSync("sh", ["-c", 'command -v "$1"', "sh", name], {
      encoding: "utf8",
    }).trim();
    return found.startsWith("/") ? found : null;
  } catch {
    return null;
  }
}

const HOST_SOCAT = hostCommand("socat");
const HOST_PYTHON3 = hostCommand("python3");
const hostToolPath = (name: string) => (name === "socat" ? HOST_SOCAT! : HOST_PYTHON3!);

/** A Unix socket server that resolves with the first line a client writes. */
async function listenForLine(socketPath: string) {
  let resolveLine!: (line: string) => void;
  const line = new Promise<string>((resolve) => {
    resolveLine = resolve;
  });
  const server = NodeNet.createServer((connection) => {
    let received = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n")) resolveLine(received.slice(0, received.indexOf("\n") + 1));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { line, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Runs what Hyprland runs for a bind value: Hyprlang turns `##` into `#`, and `exec` hands the
 * rest to `/bin/sh -c`. `PATH` is the compositor's, which need not hold the app's tools.
 */
function runBind(value: string, path = "/nonexistent-compositor-path") {
  const decoded = value.replaceAll("##", "#");
  const command = decoded.slice(decoded.indexOf(",exec,") + ",exec,".length);
  return new Promise<number>((resolve) => {
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", command], {
      env: { PATH: path },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

/** A temporary directory with a launcher that records the arguments it was started with. */
function makeLauncherDir(name = "mesura-binds-") {
  const directory = makeTempDir(name);
  const launcher = NodePath.join(directory, "fake-launcher");
  NodeFS.writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" > "$0.args"\n`, { mode: 0o755 });
  return {
    directory,
    launcher,
    launched: () =>
      NodeFS.existsSync(`${launcher}.args`)
        ? NodeFS.readFileSync(`${launcher}.args`, "utf8")
        : null,
    [Symbol.dispose]: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
  };
}

function makeTempDir(name: string) {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), name));
}

describe("search unification phase 4 rework: the bind lines Hyprland runs", () => {
  it.skipIf(HOST_SOCAT === null)(
    "search unification phase 4 rework P1-2: a socat client found on the app's PATH runs where the compositor's PATH lacks it",
    async () => {
      using dir = makeLauncherDir();
      const socketPath = NodePath.join(dir.directory, "mesura-dictation-4242.sock");
      const server = await listenForLine(socketPath);
      const { binds, bindValue } = makeBinds(
        HYPRLAND,
        [dir.launcher],
        [],
        ["socat"],
        socketPath,
        hostToolPath,
      );
      await binds.setSessionActive(true);
      expect(await runBind(bindValue("I")!)).toBe(0);
      expect(await server.line).toBe("--dictation mode inject\n");
      expect(dir.launched(), "the socket answered, so nothing relaunched").toBeNull();
      await server.close();
    },
  );

  it.skipIf(HOST_PYTHON3 === null)(
    "search unification phase 4 rework P1-2: a python3 client found on the app's PATH runs where the compositor's PATH lacks it",
    async () => {
      using dir = makeLauncherDir();
      const socketPath = NodePath.join(dir.directory, "mesura-dictation-4242.sock");
      const server = await listenForLine(socketPath);
      const { binds, bindValue } = makeBinds(
        HYPRLAND,
        [dir.launcher],
        [],
        ["python3"],
        socketPath,
        hostToolPath,
      );
      await binds.setSessionActive(true);
      expect(await runBind(bindValue("space")!)).toBe(0);
      expect(await server.line).toBe("--dictation pause\n");
      await server.close();
    },
  );

  it.skipIf(HOST_SOCAT === null || HOST_PYTHON3 === null)(
    "search unification phase 4 rework P1-2: a key whose socket client cannot connect relaunches the app with its words",
    async () => {
      for (const tool of ["socat", "python3"]) {
        using dir = makeLauncherDir();
        // No server: the socket is gone, as after a crash.
        const socketPath = NodePath.join(dir.directory, "mesura-dictation-4242.sock");
        const { binds, bindValue } = makeBinds(
          HYPRLAND,
          [dir.launcher],
          [],
          [tool],
          socketPath,
          hostToolPath,
        );
        await binds.setSessionActive(true);
        await runBind(bindValue("Return")!);
        expect(dir.launched(), tool).toBe("--dictation mode submit\n");
      }
    },
  );

  it.skipIf(HOST_PYTHON3 === null)(
    "search unification phase 4 rework P2-2: a socket path socat cannot address is reached through python3",
    async () => {
      using dir = makeLauncherDir("mesura, it's odd-");
      const socketPath = NodePath.join(dir.directory, "mesura-dictation-4242.sock");
      const server = await listenForLine(socketPath);
      const { binds, bindValue } = makeBinds(
        HYPRLAND,
        [dir.launcher],
        [],
        ["socat", "python3"],
        socketPath,
        hostToolPath,
      );
      await binds.setSessionActive(true);
      const value = bindValue("I")!;
      expect(value).not.toContain("socat");
      expect(await runBind(value)).toBe(0);
      expect(await server.line).toBe("--dictation mode inject\n");
      expect(dir.launched()).toBeNull();
      await server.close();
    },
  );

  it.skipIf(HOST_PYTHON3 === null)(
    "search unification phase 4 rework P2-3: a hash in the socket path survives Hyprlang's comment stripping",
    async () => {
      using dir = makeLauncherDir("mesura #2-");
      const socketPath = NodePath.join(dir.directory, "mesura-dictation-4242.sock");
      const server = await listenForLine(socketPath);
      const { binds, bindValue } = makeBinds(
        HYPRLAND,
        [dir.launcher],
        [],
        ["python3"],
        socketPath,
        hostToolPath,
      );
      await binds.setSessionActive(true);
      const value = bindValue("X")!;
      expect(value).toContain("mesura ##2-");
      expect(await runBind(value)).toBe(0);
      expect(await server.line).toBe("--dictation cancel\n");
      await server.close();
    },
  );
});

describe("search unification phase 4 rework: binds that existed before the session", () => {
  it("search unification phase 4 regression: a session whose socket could not listen binds the launcher line", async () => {
    const { binds, batches, resolveCommand } = makeBinds(
      HYPRLAND,
      LAUNCHER,
      [],
      ["socat", "python3"],
    );
    await binds.setSessionActive(true, false);
    expect(batches()).toEqual([BIND_BATCH]);
    expect(resolveCommand).not.toHaveBeenCalled();
  });

  it("search unification phase 4 rework P2-1: a user bind whose text quotes the dictation words is put back", async () => {
    const userArg = "notify-send '--dictation mode inject'";
    const { binds, writes } = makeBinds(HYPRLAND, LAUNCHER, [
      reportedBind({ key: "I", arg: userArg }),
    ]);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(writes().at(-1)).toEqual(["keyword", "bind", `ALT,I,exec,${userArg}`]);
  });

  it("search unification phase 4 rework P2-3: a restored bind with a hash in it is written with Hyprlang's escape", async () => {
    const userArg = "notify-send 'colour #ff0000'";
    const { binds, writes } = makeBinds(HYPRLAND, LAUNCHER, [
      reportedBind({ key: "S", arg: userArg }),
    ]);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(writes().at(-1)).toEqual([
      "keyword",
      "bind",
      "ALT,S,exec,notify-send 'colour ##ff0000'",
    ]);
  });
});
