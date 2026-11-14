/**
 * The Lua half of the `hyprctl` boundary, against replies recorded from Hyprland 0.57.1 with a
 * Lua config: `eval` prints `ok` and exits 0, or prints `error: …` and exits 7, which `execFile`
 * turns into a rejection carrying that output.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { createHyprlandConfigProviderReader, luaString, runLuaEval } from "./hyprctl.ts";

const exitSeven = (stdout: string) =>
  Object.assign(new Error("Command failed: hyprctl eval"), { code: 7, stdout });

describe("hyprctl under a Lua config", () => {
  it("reads the provider from hyprctl -j status", async () => {
    const execute = vi.fn(async () => ({ stdout: '{"configProvider": "lua", "backend": "drm"}' }));
    await expect(createHyprlandConfigProviderReader(execute)()).resolves.toBe("lua");
    expect(execute).toHaveBeenCalledWith("hyprctl", ["-j", "status"]);
  });

  it("treats a Hyprland without status as Hyprlang", async () => {
    const read = createHyprlandConfigProviderReader(async () => ({ stdout: "unknown request" }));
    await expect(read()).resolves.toBe("hyprlang");
  });

  it("keeps the last reported provider when a later read fails", async () => {
    const replies: Array<() => { stdout: string }> = [
      () => ({ stdout: '{"configProvider": "lua"}' }),
      () => {
        throw new Error("hyprctl timed out");
      },
      () => ({ stdout: "{ truncated" }),
    ];
    const read = createHyprlandConfigProviderReader(async () => replies.shift()!());
    expect([await read(), await read(), await read()]).toEqual(["lua", "lua", "lua"]);
  });

  it("assumes Hyprlang when no read has ever succeeded", async () => {
    const read = createHyprlandConfigProviderReader(async () => {
      throw new Error("spawn hyprctl ENOENT");
    });
    await expect(read()).resolves.toBe("hyprlang");
  });

  it("reports an eval that Hyprland refused, from the output of its non-zero exit", async () => {
    const refusal = "error: [string \"x\"]:1: hl.window_rule: unknown field 'not_a_real_effect'";
    await expect(
      runLuaEval(async () => {
        throw exitSeven(refusal);
      }, "x"),
    ).resolves.toEqual([refusal]);
    await expect(runLuaEval(async () => ({ stdout: "ok" }), "x")).resolves.toEqual([]);
  });

  it("rethrows when hyprctl itself could not run", async () => {
    const missing = new Error("spawn hyprctl ENOENT");
    await expect(
      runLuaEval(async () => {
        throw missing;
      }, "x"),
    ).rejects.toBe(missing);
  });

  it("quotes any text as one Lua string literal", () => {
    expect(luaString(`a "quoted" \\ path`)).toBe(`"a \\"quoted\\" \\\\ path"`);
    // A decimal escape takes up to three digits, so a digit after a control character stays text.
    expect(luaString("line\n1")).toBe(`"line\\0101"`);
  });
});
