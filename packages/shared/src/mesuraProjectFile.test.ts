import { describe, expect, it } from "vite-plus/test";

import {
  parseMesuraProjectFile,
  parseT3ProjectFile,
  resolveRepositoryDefaults,
} from "./t3ProjectFile.ts";

describe("Mesura repository validation", () => {
  it("rejects valid model and workspace defaults together with an invalid icon field", () => {
    expect(
      parseMesuraProjectFile(
        JSON.stringify({
          version: 1,
          iconPath: "../outside.svg",
          defaultModelSelection: {
            provider: "codex",
            model: "portable-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          defaultThreadEnvMode: "worktree",
        }),
      ),
    ).toBeNull();
  });

  it("accepts a local editor schema reference alongside portable defaults", () => {
    expect(
      parseMesuraProjectFile(`{
        "$schema": "./tools/mesura.schema.json",
        "version": 1,
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({
      $schema: "./tools/mesura.schema.json",
      version: 1,
      defaultThreadEnvMode: "worktree",
    });
    expect(parseMesuraProjectFile('{ "$schema": 7, "version": 1 }')).toBeNull();
  });

  it("rejects Windows roots, traversal, empty paths and missing schema versions", () => {
    for (const iconPath of [
      "C:/brand.svg",
      "C:\\brand.svg",
      "C:brand.svg",
      "\\\\server\\share\\brand.svg",
      "\\brand.svg",
      "..\\brand.svg",
      "./../brand.svg",
      "assets/../../../brand.svg",
      "assets/..",
      ".",
      " ",
      "assets/brand\0.svg",
    ]) {
      expect(parseMesuraProjectFile(JSON.stringify({ version: 1, iconPath }))).toBeNull();
    }
    expect(parseMesuraProjectFile("{}")).toBeNull();
    expect(parseMesuraProjectFile('{ "version": "1" }')).toBeNull();
  });

  it("keeps portable options and an unknown driver without routing to a local instance", () => {
    const selection = {
      provider: "custom_driver",
      model: "vendor/model-name",
      options: [{ id: "fastMode", value: false }],
    };
    expect(
      parseMesuraProjectFile(JSON.stringify({ version: 1, defaultModelSelection: selection })),
    ).toEqual({ version: 1, defaultModelSelection: selection });
    for (const defaultModelSelection of [
      { ...selection, model: " " },
      { ...selection, provider: "bad/driver" },
      { ...selection, options: [{ id: "effort", value: 7 }] },
      { ...selection, options: [{ id: "", value: "high" }] },
      { providerInstanceId: "codex_personal", model: "model" },
    ]) {
      expect(
        parseMesuraProjectFile(JSON.stringify({ version: 1, defaultModelSelection })),
      ).toBeNull();
    }
  });

  it("accepts JSONC and relative parent segments that stay within the checkout", () => {
    expect(
      parseMesuraProjectFile(`{
      // A path can traverse inside this checkout.
      "version": 1,
      "iconPath": " assets/../brand.svg ",
    }`),
    ).toEqual({ version: 1, iconPath: "assets/../brand.svg" });
  });

  it("resolves a portable model independently and never imports scripts from Mesura", () => {
    const mesura = parseMesuraProjectFile(
      JSON.stringify({
        version: 1,
        iconPath: "brand/portable.svg",
        defaultModelSelection: { provider: "codex", model: "model" },
        scripts: [{ name: "Untrusted", command: "do-not-run" }],
      }),
    );
    const legacy = parseT3ProjectFile(
      JSON.stringify({
        iconPath: "brand/legacy.svg",
        defaultThreadEnvMode: "local",
        scripts: [{ name: "Setup", command: "pnpm install", runOnWorktreeCreate: true }],
      }),
    );
    const defaults = resolveRepositoryDefaults(mesura, legacy);
    expect(defaults.defaultModelSelection).toEqual({
      value: { provider: "codex", model: "model" },
      source: "mesura",
    });
    expect(defaults.defaultThreadEnvMode).toEqual({ value: "local", source: "t3" });
    expect(defaults.iconCandidates).toEqual([
      { value: "brand/portable.svg", source: "mesura" },
      { value: "brand/legacy.svg", source: "t3" },
    ]);
    expect(defaults.scripts).toEqual(legacy?.scripts);
    expect(resolveRepositoryDefaults(mesura, null).scripts).toEqual([]);
  });
});
