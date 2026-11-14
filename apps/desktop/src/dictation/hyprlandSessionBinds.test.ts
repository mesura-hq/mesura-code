// @effect-diagnostics nodeBuiltinImport:off - the rework specs run the generated bind lines
// through `/bin/sh` against a real Unix socket, as Hyprland would.
/**
 * Entry point: `createHyprlandSessionBinds`, driven by the renderer's dictation state and app quit,
 * with `hyprctl` injected as in `snapShot/CaptureShortcutConfig.ts` and the PATH lookup injected
 * as `resolveCommand`.
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

/** Asked before each bind; a Hyprlang Hyprland 0.56.2 has no `configProvider` to report. */
const READ_STATUS = ["hyprctl", ["-j", "status"]];

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
  // While the session's binds are in place, Hyprland reports them instead of the ones they replaced.
  let sessionBinds: Array<Record<string, unknown>> = [];
  const execute = vi.fn(async (_file: string, args: ReadonlyArray<string>) => {
    if (args[0] === "--batch") {
      const sent = args[1]!
        .split(" ; ")
        .filter((line) => line.startsWith("keyword bind ALT,"))
        .map((line) => {
          const [key, , ...arg] = line.slice("keyword bind ALT,".length).split(",");
          return reportedBind({ key, arg: arg.join(",") });
        });
      if (sent.length > 0) sessionBinds = sent;
      else if (args[1]!.includes("keyword unbind")) sessionBinds = [];
    }
    if (args[0] !== "-j") return undefined;
    if (existing instanceof Error) throw existing;
    if (args[1] === "binds" && sessionBinds.length > 0)
      return { stdout: JSON.stringify(sessionBinds) };
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
    expect(execute.mock.calls).toEqual([
      READ_STATUS,
      READ_BINDS,
      ["hyprctl", ["--batch", BIND_BATCH]],
    ]);
  });

  it("dictation phase 6 AC5: a session that is already bound is not bound a second time", async () => {
    const { binds, execute } = makeBinds(HYPRLAND);
    await binds.setSessionActive(true);
    await binds.setSessionActive(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("dictation phase 6 AC5: a session end unbinds the six Alt keys", async () => {
    const { binds, execute } = makeBinds(HYPRLAND);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(execute.mock.calls.at(-1)).toEqual(["hyprctl", ["--batch", UNBIND_BATCH]]);
    // Status and binds read, the bind batch, the binds read again, the unbind batch.
    expect(execute).toHaveBeenCalledTimes(5);
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

/**
 * A Hyprland 0.57.1 whose provider can switch, as a config migrated while the app runs does at
 * its next reload. Under Lua, `keyword` and `--batch` print `unknown request` and exit 0.
 */
function makeSwitchingBinds(initial: "hyprlang" | "lua") {
  let provider = initial;
  const execute = vi.fn(async (_file: string, args: ReadonlyArray<string>) => {
    if (args[0] === "-j" && args[1] === "status")
      return { stdout: JSON.stringify(provider === "lua" ? { configProvider: "lua" } : {}) };
    if (args[0] === "-j") return { stdout: "[]" };
    if (args[0] === "eval") return { stdout: provider === "lua" ? "ok" : "unknown request" };
    return { stdout: provider === "lua" ? "unknown request" : "ok" };
  });
  const onError = vi.fn();
  const binds = createHyprlandSessionBinds({
    env: HYPRLAND,
    launcher: LAUNCHER,
    socketPath: SOCKET_PATH,
    resolveCommand: async () => null,
    execute,
    onError,
  });
  const writes = () =>
    execute.mock.calls
      .filter(([, args]) => args[0] === "eval" || args[0] === "--batch")
      .map(([, args]) => ({ via: args[0]!, text: args[1]! }));
  return {
    binds,
    execute,
    onError,
    writes,
    switchTo: (next: "hyprlang" | "lua") => {
      provider = next;
    },
  };
}

const SESSION_COMBOS = ["S", "I", "Return", "space", "R", "X"];

describe("dictation session binds under a Lua config", () => {
  it("adds the six Alt keys as handles through hyprctl eval, unbinding nothing the config owns", async () => {
    const { binds, writes, onError } = makeSwitchingBinds("lua");
    await binds.setSessionActive(true);
    expect(onError).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
    const { via, text } = writes()[0]!;
    expect(via).toBe("eval");
    for (const key of SESSION_COMBOS) expect(text).toContain(`hl.bind("ALT + ${key}", `);
    expect(text).toContain('hl.dsp.exec_cmd("/usr/bin/mesura-code --dictation pause")');
    // `hl.unbind` would also delete Symmetria's recorder keys, which Lua cannot bind again.
    expect(text).not.toContain("hl.unbind");
  });

  it("removes only its own handles at session end", async () => {
    const { binds, writes } = makeSwitchingBinds("lua");
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    const end = writes().at(-1)!;
    expect(end.via).toBe("eval");
    expect(end.text).toContain("pcall(handle.remove, handle)");
    expect(end.text).not.toContain("hl.bind(");
    expect(end.text).not.toContain("hl.unbind");
  });
});

describe("dictation session binds after a Hyprland config reload", () => {
  it("binds the keys again while the session lasts", async () => {
    const { binds, writes } = makeSwitchingBinds("lua");
    await binds.setSessionActive(true);
    await binds.reapply();
    expect(writes().filter(({ text }) => text.includes("hl.bind("))).toHaveLength(2);
  });

  it("binds nothing once the session has ended", async () => {
    const { binds, writes } = makeSwitchingBinds("hyprlang");
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    const before = writes().length;
    await binds.reapply();
    expect(writes()).toHaveLength(before);
  });

  it("leaves no session keys when the session ends while the reload is still binding", async () => {
    const { binds, writes } = makeSwitchingBinds("lua");
    await binds.setSessionActive(true);
    const reload = binds.reapply();
    const end = binds.setSessionActive(false);
    await Promise.all([reload, end]);
    const last = writes().at(-1)!;
    expect(last.text).toContain("pcall(handle.remove, handle)");
    expect(last.text).not.toContain("hl.bind(");
  });

  it("follows a config migrated to Lua mid-session, and unbinds the way it last bound", async () => {
    const { binds, writes, switchTo, onError } = makeSwitchingBinds("hyprlang");
    await binds.setSessionActive(true);
    expect(writes()[0]!.via).toBe("--batch");
    switchTo("lua");
    await binds.reapply();
    await binds.setSessionActive(false);
    expect(
      writes()
        .slice(1)
        .map(({ via }) => via),
    ).toEqual(["eval", "eval"]);
    expect(onError).not.toHaveBeenCalled();
  });
});

/**
 * A Hyprlang compositor that keeps its binds: `unbind ALT,<key>` deletes every bind on the combo,
 * `bind…` adds one, and `reload()` puts the config's binds back, as Hyprland 0.56.2 does.
 */
function makeStatefulHyprlang(config: ReadonlyArray<Record<string, unknown>>) {
  let live = config.map((bind) => ({ ...bind }));
  const apply = (keyword: string, value: string) => {
    const [, key, ...rest] = value.split(",");
    if (keyword === "unbind") live = live.filter((bind) => bind.key !== key);
    else if (keyword.startsWith("bind")) {
      // The flag letters follow `bind`, whose own letters include a `d`.
      const described = keyword.slice("bind".length).includes("d");
      const description = described ? rest.shift()! : "";
      const [dispatcher, ...arg] = rest;
      live.push(
        reportedBind({
          key,
          dispatcher,
          arg: arg.join(","),
          has_description: described,
          description,
        }),
      );
    }
  };
  let provider: "hyprlang" | "lua" = "hyprlang";
  const execute = vi.fn(async (_file: string, args: ReadonlyArray<string>) => {
    if (args[0] === "-j" && args[1] === "status")
      return { stdout: provider === "lua" ? '{"configProvider": "lua"}' : "{}" };
    if (args[0] === "eval") return { stdout: "ok" };
    if (args[0] === "-j") return { stdout: JSON.stringify(live) };
    if (args[0] === "--batch")
      for (const line of args[1]!.split(" ; ")) {
        const [, keyword, ...value] = line.split(" ");
        apply(keyword!, value.join(" "));
      }
    else if (args[0] === "keyword") apply(args[1]!, args[2]!);
    return { stdout: "ok" };
  });
  return {
    execute,
    binds: () => live,
    /** `changed` is the config as the file now says, when it was edited before the reload. */
    reload: (changed: ReadonlyArray<Record<string, unknown>> = config) => {
      live = changed.map((bind) => ({ ...bind }));
    },
    setProvider: (next: "hyprlang" | "lua") => {
      provider = next;
    },
  };
}

describe("dictation session binds keep the config's binds across a reload", () => {
  const RECORDER_CANCEL = reportedBind({
    key: "X",
    arg: "qs -c symmetria ipc call recorder cancel",
  });

  it("restores the config's bind when a second bind found its own binds still in place", async () => {
    // The reload landed before the first bind ran, so the reapply it queued finds this session's
    // binds, not the config's, and must not take them for the config's.
    const hyprland = makeStatefulHyprlang([RECORDER_CANCEL]);
    const binds = createHyprlandSessionBinds({
      env: HYPRLAND,
      launcher: LAUNCHER,
      socketPath: SOCKET_PATH,
      resolveCommand: async () => null,
      execute: hyprland.execute,
    });
    await binds.setSessionActive(true);
    await binds.reapply();
    await binds.setSessionActive(false);
    expect(hyprland.binds().map(({ key, arg }) => ({ key, arg }))).toEqual([
      { key: "X", arg: "qs -c symmetria ipc call recorder cancel" },
    ]);
  });

  it("takes a new snapshot after a real reload, and still restores the config's bind", async () => {
    const hyprland = makeStatefulHyprlang([RECORDER_CANCEL]);
    const binds = createHyprlandSessionBinds({
      env: HYPRLAND,
      launcher: LAUNCHER,
      socketPath: SOCKET_PATH,
      resolveCommand: async () => null,
      execute: hyprland.execute,
    });
    await binds.setSessionActive(true);
    hyprland.reload();
    await binds.reapply();
    await binds.setSessionActive(false);
    expect(hyprland.binds().map(({ key, arg }) => ({ key, arg }))).toEqual([
      { key: "X", arg: "qs -c symmetria ipc call recorder cancel" },
    ]);
  });
});

describe("dictation session binds under a Lua config, across processes and failed reads", () => {
  it("removes the keys at session end only while this process still owns them", async () => {
    const { binds, writes } = makeSwitchingBinds("lua");
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    const [start, end] = writes().map(({ text }) => text);
    // The operator's keybindings.lua guards its recorder keys on this exact global.
    expect(start).toMatch(/^.* _G\.__mesura_dictation_binds = \{ owner = /);
    expect(start).toContain(`owner = "${SOCKET_PATH}"`);
    // Another process that started later replaced the owner, and keeps its keys.
    expect(end).toMatch(
      new RegExp(
        `^if \\(_G\\.__mesura_dictation_binds or \\{\\}\\)\\.owner == "${SOCKET_PATH}" then `,
      ),
    );
  });

  it("stays on Lua when the provider read fails after Lua was reported", async () => {
    const { binds, execute, writes, onError } = makeSwitchingBinds("lua");
    await binds.setSessionActive(true);
    const answer = execute.getMockImplementation()!;
    execute.mockImplementation(async (file, args) => {
      if (args[0] === "-j" && args[1] === "status") throw new Error("hyprctl timed out");
      return answer(file, args);
    });
    await binds.reapply();
    await binds.setSessionActive(false);
    expect(writes().map(({ via }) => via)).toEqual(["eval", "eval", "eval"]);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("dictation session binds take the config's binds as Hyprland reports them", () => {
  const RECORDER_CANCEL = reportedBind({
    key: "X",
    arg: "qs -c symmetria ipc call recorder cancel",
  });
  const makeSession = (hyprland: ReturnType<typeof makeStatefulHyprlang>) =>
    createHyprlandSessionBinds({
      env: HYPRLAND,
      launcher: LAUNCHER,
      socketPath: SOCKET_PATH,
      resolveCommand: async () => null,
      execute: hyprland.execute,
    });
  const remaining = (hyprland: ReturnType<typeof makeStatefulHyprlang>) =>
    hyprland.binds().map(({ key, arg }) => ({ key, arg }));

  it("snapshots every other combo at the first bind, even beside a bind shaped like its own", async () => {
    // A user bind that runs the launcher's own words looks generated and is not restored; the
    // recorder's bind on another combo must not be lost with it.
    const hyprland = makeStatefulHyprlang([
      reportedBind({ key: "S", arg: "/usr/bin/mesura-code --dictation mode clipboard" }),
      RECORDER_CANCEL,
    ]);
    const binds = makeSession(hyprland);
    await binds.setSessionActive(true);
    await binds.setSessionActive(false);
    expect(remaining(hyprland)).toEqual([
      { key: "X", arg: "qs -c symmetria ipc call recorder cancel" },
    ]);
  });

  it("leaves the reloaded config alone when a reload it missed already removed its binds", async () => {
    const hyprland = makeStatefulHyprlang([RECORDER_CANCEL]);
    const binds = makeSession(hyprland);
    await binds.setSessionActive(true);
    // The config file changed and Hyprland reloaded it; the event socket did not report it.
    hyprland.reload([reportedBind({ key: "X", arg: "qs -c symmetria ipc call recorder stop" })]);
    await binds.setSessionActive(false);
    expect(remaining(hyprland)).toEqual([
      { key: "X", arg: "qs -c symmetria ipc call recorder stop" },
    ]);
  });
});

describe("dictation session binds under a Lua config, after a reload with two sessions", () => {
  it("binds again only while no session that started later holds the keys", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const older = makeSwitchingBinds("lua");
      await older.binds.setSessionActive(true);
      vi.setSystemTime(2_000);
      await older.binds.reapply();
      const [first, again] = older.writes().map(({ text }) => text);
      // Started at 1000, it binds over a holder that started earlier, or at once with a lower socket
      // path, and so does its reapply.
      for (const lua of [first, again])
        expect(lua).toMatch(
          /^local held = _G\.__mesura_dictation_binds if held == nil or held\.owner == (".+") or held\.startedAt < 1000 or \(held\.startedAt == 1000 and held\.owner < \1\) then /,
        );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dictation session binds tell this session's binds from any other", () => {
  const RECORDER = (action: string) =>
    reportedBind({ key: "X", arg: `qs -c symmetria ipc call recorder ${action}` });
  const keysAndArgs = (hyprland: ReturnType<typeof makeStatefulHyprlang>) =>
    hyprland.binds().map(({ key, arg }) => ({ key, arg }));

  it("leaves a reloaded config alone when only another instance's leftover bind remains", async () => {
    const hyprland = makeStatefulHyprlang([RECORDER("cancel")]);
    const binds = createHyprlandSessionBinds({
      env: HYPRLAND,
      launcher: LAUNCHER,
      socketPath: SOCKET_PATH,
      resolveCommand: async (name) => (name === "python3" ? "/usr/bin/python3" : null),
      execute: hyprland.execute,
    });
    await binds.setSessionActive(true);
    // A crashed instance's bind writes to its own socket; it is shaped like ours but is not.
    const leftover = reportedBind({
      key: "S",
      arg: "/usr/bin/python3 -c x /run/user/1000/mesura-dictation-999.sock --dictation mode clipboard",
    });
    hyprland.reload([RECORDER("stop"), leftover]);
    await binds.setSessionActive(false);
    expect(keysAndArgs(hyprland)).toEqual([
      { key: "X", arg: "qs -c symmetria ipc call recorder stop" },
      { key: "S", arg: leftover.arg },
    ]);
  });

  it("takes a new snapshot after the config moved from Lua to Hyprlang", async () => {
    const hyprland = makeStatefulHyprlang([RECORDER("cancel")]);
    hyprland.setProvider("lua");
    const binds = createHyprlandSessionBinds({
      env: HYPRLAND,
      launcher: LAUNCHER,
      socketPath: SOCKET_PATH,
      resolveCommand: async () => null,
      execute: hyprland.execute,
    });
    await binds.setSessionActive(true);
    hyprland.setProvider("hyprlang");
    hyprland.reload();
    await binds.reapply();
    await binds.setSessionActive(false);
    expect(keysAndArgs(hyprland)).toEqual([
      { key: "X", arg: "qs -c symmetria ipc call recorder cancel" },
    ]);
  });
});

describe("dictation session binds retry a removal Hyprland did not take", () => {
  it("sends the removal again at the next end, since the keys and the global are still there", async () => {
    const { binds, execute, writes } = makeSwitchingBinds("lua");
    await binds.setSessionActive(true);
    // The removal is the end's first and only call; Hyprland refuses it once.
    execute.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Command failed"), { code: 7, stdout: "error: busy" });
    });
    await binds.setSessionActive(false);
    await binds.dispose();
    const removals = writes().filter(
      ({ text }) => text.includes("pcall(handle.remove, handle)") && !text.includes("hl.bind("),
    );
    expect(removals).toHaveLength(2);
    // Once Hyprland took it, a further end sends nothing.
    await binds.dispose();
    expect(writes()).toHaveLength(3);
  });
});
