/**
 * Entry point: `resolveDictationLauncher`, which `DesktopDictationWidget` feeds with this
 * process's argv and environment to build the command the Hyprland session binds run.
 *
 * STT redesign, phase 6, criterion 5 (verification ①: the development bind could not start).
 */
import { describe, expect, it } from "vite-plus/test";

import { dictationSocketCommand } from "./dictationControlSocket.ts";
import { createHyprlandSessionBinds } from "./hyprlandSessionBinds.ts";
import { resolveDictationLauncher } from "./dictationLauncher.ts";

const ELECTRON = "/repo/node_modules/.pnpm/electron@44.1.0/node_modules/electron/dist/electron";
const DESKTOP = "/repo/apps/desktop";
/** `process.argv` of a `vp run dev:desktop` app, as `scripts/dev-electron.mjs` starts it. */
const DEV_ARGV = [
  ELECTRON,
  "--no-sandbox",
  "--remote-debugging-port=9333",
  `--t3code-dev-root=${DESKTOP}`,
  "dist-electron/main.cjs",
];
const DEV_ENV = { VITE_DEV_SERVER_URL: "http://127.0.0.1:6328" };

const development = (overrides: Partial<Parameters<typeof resolveDictationLauncher>[0]> = {}) =>
  resolveDictationLauncher({
    appImagePath: null,
    isDevelopment: true,
    execPath: ELECTRON,
    argv: DEV_ARGV,
    cwd: DESKTOP,
    env: DEV_ENV,
    ...overrides,
  });

describe("dictation phase 6 regressions: bind launcher", () => {
  it("dictation phase 6 regression: a development bind runs the absolute entry script with the dev switches and environment", () => {
    expect(development()).toEqual([
      "env",
      "VITE_DEV_SERVER_URL=http://127.0.0.1:6328",
      ELECTRON,
      "--no-sandbox",
      `--t3code-dev-root=${DESKTOP}`,
      `${DESKTOP}/dist-electron/main.cjs`,
    ]);
  });

  it("dictation phase 6 regression: a development bind carries XDG_CONFIG_HOME, which places the single-instance lock", () => {
    expect(development({ env: { ...DEV_ENV, XDG_CONFIG_HOME: "/home/dev/.config-alt" } })).toEqual([
      "env",
      "VITE_DEV_SERVER_URL=http://127.0.0.1:6328",
      "XDG_CONFIG_HOME=/home/dev/.config-alt",
      ELECTRON,
      "--no-sandbox",
      `--t3code-dev-root=${DESKTOP}`,
      `${DESKTOP}/dist-electron/main.cjs`,
    ]);
  });

  it("dictation phase 6 regression: a development instance started by a dictation command line binds without that command", () => {
    expect(development({ argv: [...DEV_ARGV, "--dictation", "toggle"] }).slice(-1)).toEqual([
      `${DESKTOP}/dist-electron/main.cjs`,
    ]);
  });

  it("dictation phase 6 guard: a packaged build with the default environment binds the AppImage or the executable alone", () => {
    expect(
      resolveDictationLauncher({
        appImagePath: "/home/dev/Applications/Mesura-Code.AppImage",
        isDevelopment: false,
        execPath: "/tmp/.mount_Mesura/mesura-code",
        argv: ["/tmp/.mount_Mesura/mesura-code", "--no-sandbox"],
        cwd: "/",
        env: {},
      }),
    ).toEqual(["/home/dev/Applications/Mesura-Code.AppImage"]);
    expect(
      resolveDictationLauncher({
        appImagePath: null,
        isDevelopment: false,
        execPath: "/usr/bin/mesura-code",
        argv: ["/usr/bin/mesura-code", "--enable-features=X"],
        cwd: "/",
        env: {},
      }),
    ).toEqual(["/usr/bin/mesura-code"]);
  });

  // This guard used to pin "the AppImage alone" even with XDG_CONFIG_HOME set. Hyprland runs
  // binds with its own environment, so a side-by-side test install isolated through
  // XDG_CONFIG_HOME and T3CODE_HOME was never reached: its session keys hit the stable
  // install's lock instead. The bind line has to carry both variables whenever they are set.
  it("a packaged build isolated through XDG_CONFIG_HOME and T3CODE_HOME carries both on its bind line", () => {
    expect(
      resolveDictationLauncher({
        appImagePath: "/home/jc/Applications/Mesura-Code-stt-test.AppImage",
        isDevelopment: false,
        execPath: "/tmp/.mount_Mesura/mesura-code",
        argv: ["/tmp/.mount_Mesura/mesura-code"],
        cwd: "/",
        env: {
          XDG_CONFIG_HOME: "/home/jc/.local/state/mesura-stt-test/config",
          T3CODE_HOME: "/home/jc/.local/state/mesura-stt-test/home",
          VITE_DEV_SERVER_URL: "http://ignored-when-packaged",
        },
      }),
    ).toEqual([
      "env",
      "XDG_CONFIG_HOME=/home/jc/.local/state/mesura-stt-test/config",
      "T3CODE_HOME=/home/jc/.local/state/mesura-stt-test/home",
      "/home/jc/Applications/Mesura-Code-stt-test.AppImage",
    ]);
  });

  it("dictation phase 6 regression: the development bind line Hyprland runs", async () => {
    const execute = async (_file: string, args: ReadonlyArray<string>) =>
      args[0] === "-j" ? { stdout: "[]" } : undefined;
    const batches: string[] = [];
    const binds = createHyprlandSessionBinds({
      env: { HYPRLAND_INSTANCE_SIGNATURE: "fence" },
      commandFor: (command) =>
        dictationSocketCommand({ socketPath: "/run/s.sock", launcher: development(), command }),
      execute: async (file, args) => {
        if (args[0] === "--batch") batches.push(args[1]!);
        return execute(file, args);
      },
    });
    await binds.setSessionActive(true);
    expect(batches[0]).toContain(
      `2>/dev/null || env VITE_DEV_SERVER_URL=http://127.0.0.1:6328 ${ELECTRON} --no-sandbox --t3code-dev-root=${DESKTOP} ${DESKTOP}/dist-electron/main.cjs --dictation mode clipboard ; `,
    );
  });
});
