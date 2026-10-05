/**
 * Entry point: `createHyprlandSessionBinds`, which the desktop main process
 * drives from the renderer's dictation state and from app quit, with the
 * `hyprctl` execution injected the way `snapShot/CaptureShortcutConfig.ts`
 * injects its own.
 *
 * STT redesign, phase 6, criterion 5.
 */
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

/** `existing` is what `hyprctl -j binds` reports; an Error makes the read fail. */
function makeBinds(
  env: Record<string, string | undefined>,
  launcher = LAUNCHER,
  existing: ReadonlyArray<Record<string, unknown>> | Error = [],
) {
  const execute = vi.fn(async (_file: string, args: ReadonlyArray<string>) => {
    if (args[0] !== "-j") return undefined;
    if (existing instanceof Error) throw existing;
    return { stdout: JSON.stringify(existing) };
  });
  const onError = vi.fn();
  const binds = createHyprlandSessionBinds({ env, launcher, execute, onError });
  const batches = () =>
    execute.mock.calls.filter(([, args]) => args[0] === "--batch").map(([, args]) => args[1]);
  /** Every write to Hyprland in order: a batch as its string, a single keyword as its vector. */
  const writes = () =>
    execute.mock.calls
      .filter(([, args]) => args[0] !== "-j")
      .map(([, args]) => (args[0] === "--batch" ? args[1] : [...args]));
  return { binds, execute, batches, writes, onError };
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
