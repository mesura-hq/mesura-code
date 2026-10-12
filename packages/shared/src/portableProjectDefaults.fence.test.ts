import { describe, expect, it } from "vite-plus/test";

import { MesuraProjectFile } from "@t3tools/contracts";
import artifact from "../../contracts/mesura.schema.json" with { type: "json" };
import { buildMesuraProjectFileJsonSchema, parseMesuraProjectFile } from "./t3ProjectFile.ts";

describe("portable repository file fence", () => {
  it("accepts the versioned portable fields and rejects paths outside the checkout", () => {
    expect(parseMesuraProjectFile).toBeTypeOf("function");

    const valid = parseMesuraProjectFile(
      JSON.stringify({
        version: 1,
        iconPath: "assets/brand.svg",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-6-astra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        defaultThreadEnvMode: "worktree",
      }),
    );
    expect(valid).toEqual({
      version: 1,
      iconPath: "assets/brand.svg",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      defaultThreadEnvMode: "worktree",
    });

    for (const iconPath of ["/tmp/brand.svg", "../brand.svg", "assets/../../brand.svg"]) {
      expect(parseMesuraProjectFile(JSON.stringify({ version: 1, iconPath }))).toBeNull();
    }
    expect(parseMesuraProjectFile('{ "version": 1, "defaultThreadEnvMode": "remote" }')).toBeNull();
    expect(parseMesuraProjectFile('{ "version": 2 }')).toBeNull();
    expect(
      parseMesuraProjectFile(
        '{ "version": 1, "defaultModelSelection": { "provider": "codex_personal", "model": "gpt-6-astra", "options": { "reasoningEffort": "high" } } }',
      ),
    ).toBeNull();
  });

  it("generates a local JSON Schema with only Mesura repository fields", () => {
    expect(MesuraProjectFile).toBeDefined();
    expect(buildMesuraProjectFileJsonSchema).toBeTypeOf("function");

    const document = buildMesuraProjectFileJsonSchema();
    expect(document.$id).not.toBe("https://t3.codes/schema/t3.json");
    expect(Object.keys(document.properties as Record<string, unknown>).sort()).toEqual([
      "$schema",
      "defaultModelSelection",
      "defaultThreadEnvMode",
      "iconPath",
      "version",
    ]);
    expect(document.properties).not.toHaveProperty("scripts");

    expect(artifact).toEqual(document);
  });

  it("portable repository schema regression: exports the open provider slug pattern used by the runtime", () => {
    const document = buildMesuraProjectFileJsonSchema() as typeof artifact;
    const provider = document.properties.defaultModelSelection.properties.provider;
    expect(provider.pattern).toBe("^[a-zA-Z][a-zA-Z0-9_-]*$");
    const pattern = new RegExp(provider.pattern, "u");

    for (const slug of ["codex", "custom_driver", "claudeAgent", "driver-2"]) {
      expect(pattern.test(slug)).toBe(true);
      expect(
        parseMesuraProjectFile(
          JSON.stringify({ version: 1, defaultModelSelection: { provider: slug, model: "model" } }),
        ),
      ).toEqual({ version: 1, defaultModelSelection: { provider: slug, model: "model" } });
    }
    for (const slug of ["bad/driver", "1driver", "driver space", ""]) {
      expect(pattern.test(slug)).toBe(false);
      expect(
        parseMesuraProjectFile(
          JSON.stringify({ version: 1, defaultModelSelection: { provider: slug, model: "model" } }),
        ),
      ).toBeNull();
    }
  });

  it("portable repository schema regression: closes nested editor objects while the runtime strips unknown fields", () => {
    expect(buildMesuraProjectFileJsonSchema()).toMatchObject({
      additionalProperties: false,
      properties: {
        defaultModelSelection: {
          additionalProperties: false,
          properties: { options: { items: { additionalProperties: false } } },
        },
      },
    });
    expect(
      parseMesuraProjectFile(
        JSON.stringify({
          version: 1,
          scripts: [{ name: "Ignored", command: "do-not-run" }],
          defaultModelSelection: {
            provider: "custom_driver",
            model: " model ",
            ignored: true,
            options: [{ id: "reasoningEffort", value: "high", ignored: true }],
          },
        }),
      ),
    ).toEqual({
      version: 1,
      defaultModelSelection: {
        provider: "custom_driver",
        model: "model",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });
});
