/**
 * Entry point: `parseDictationCommandLine`, the argv parser the `second-instance`
 * handler in `app/DesktopClerk.ts` runs on the argv Electron forwards.
 *
 * STT redesign, phase 6, criteria 1 and 2.
 */
import { describe, expect, it } from "vite-plus/test";

import { parseDictationCommandLine } from "./dictationCommandLine.ts";

const BINARY = "/opt/mesura-code/mesura-code";

describe("dictation phase 6 fence: command line", () => {
  it("dictation phase 6 AC1: --dictation toggle parses to the toggle command", () => {
    expect(parseDictationCommandLine([BINARY, "--dictation", "toggle"])).toBe("dictation.toggle");
  });

  it("dictation phase 6 AC2: --dictation mode, pause, restart and cancel parse to their commands", () => {
    expect(parseDictationCommandLine([BINARY, "--dictation", "mode", "clipboard"])).toBe(
      "dictation.mode.clipboard",
    );
    expect(parseDictationCommandLine([BINARY, "--dictation", "mode", "inject"])).toBe(
      "dictation.mode.inject",
    );
    expect(parseDictationCommandLine([BINARY, "--dictation", "mode", "submit"])).toBe(
      "dictation.mode.submit",
    );
    expect(parseDictationCommandLine([BINARY, "--dictation", "pause"])).toBe("dictation.pause");
    expect(parseDictationCommandLine([BINARY, "--dictation", "restart"])).toBe("dictation.restart");
    expect(parseDictationCommandLine([BINARY, "--dictation", "cancel"])).toBe("dictation.cancel");
  });

  it("dictation phase 6 AC1: a development launch with the app path before the flag still parses", () => {
    expect(
      parseDictationCommandLine([
        "/repo/node_modules/electron/dist/electron",
        "/repo/apps/desktop",
        "--dictation",
        "toggle",
      ]),
    ).toBe("dictation.toggle");
  });

  it("dictation phase 6 AC1: the argv order Chromium forwards, switches first and positionals last, still parses", () => {
    // Electron documents that `second-instance` argv may be reordered and extended.
    expect(
      parseDictationCommandLine([
        BINARY,
        "--dictation",
        "--allow-file-access-from-files",
        "--enable-features=WaylandWindowDecorations",
        "mode",
        "inject",
      ]),
    ).toBe("dictation.mode.inject");
  });

  it("dictation phase 6 guard: anything that is not a dictation command parses to null", () => {
    for (const argv of [
      [BINARY],
      [BINARY, "--some-other-switch"],
      [BINARY, "toggle"],
      [BINARY, "--dictation"],
      [BINARY, "--dictation", "record"],
      [BINARY, "--dictation", "mode"],
      [BINARY, "--dictation", "mode", "shout"],
      [BINARY, "--dictation", "Toggle"],
      [BINARY, "--dictations", "toggle"],
    ]) {
      expect(parseDictationCommandLine(argv), argv.join(" ")).toBeNull();
    }
  });
});
