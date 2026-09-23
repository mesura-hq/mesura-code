import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { resolveProjectSettings } from "./projectSettings.ts";
import { parseMesuraProjectFile, resolveRepositoryDefaults } from "./t3ProjectFile.ts";

const projectId = ProjectId.make("portable-repository");
const decodeSettings = Schema.decodeUnknownSync(Schema.toType(ServerSettings));
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const repositoryDefaults = resolveRepositoryDefaults(
  parseMesuraProjectFile(
    JSON.stringify({
      version: 1,
      defaultThreadEnvMode: "worktree",
      defaultModelSelection: {
        provider: "codex",
        model: "portable-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    }),
  ),
  null,
);

function makeEnvironment(name: string, hasProjectOverride: boolean, hasPortableModel = true) {
  const localInstanceId = `codex_${name}`;
  const localModel = { instanceId: localInstanceId, model: `${name}-model` };
  const settings = decodeSettings({
    ...DEFAULT_SERVER_SETTINGS,
    defaultThreadEnvMode: "local",
    defaultModelSelection: localModel,
    providerInstances: {
      codex: { driver: "codex" },
      [localInstanceId]: { driver: "codex" },
    },
    projectSettingsOverrides: hasProjectOverride
      ? { [projectId]: { defaultThreadEnvMode: "local", defaultModelSelection: localModel } }
      : {},
  });
  const providers = [
    { instanceId: "codex", models: hasPortableModel ? ["portable-model"] : [] },
    { instanceId: localInstanceId, models: [localModel.model] },
  ].map(({ instanceId, models }) =>
    decodeProvider({
      instanceId,
      driver: "codex",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-23T00:00:00.000Z",
      models: models.map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      })),
    }),
  );
  return { settings, providers, localModel };
}

it("resolves one repository default against two environments with independent local settings and catalogs", () => {
  // This exercises resolution with simulated environments; file loading and Git cloning are separate checks.
  const desktop = makeEnvironment("desktop", true);
  const server = makeEnvironment("server", false);
  for (const environment of [desktop, server]) {
    const resolved = resolveProjectSettings(environment.settings, projectId, null, {
      repositoryDefaults,
      providers: environment.providers,
    });
    expect(resolved.settings.defaultModelSelection).toEqual({
      instanceId: "codex",
      model: "portable-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(resolved.settings.defaultThreadEnvMode).toBe("worktree");
    expect(resolved.sources.defaultModelSelection).toBe("mesura");
    expect(resolved.sources.defaultThreadEnvMode).toBe("mesura");
    expect(resolved.modelDefaultWarning).toBeUndefined();
    expect(environment.settings.defaultModelSelection).toEqual(environment.localModel);
    expect(environment.settings.defaultThreadEnvMode).toBe("local");
  }
});

it("uses only the second environment's fallback when its catalog lacks the portable model", () => {
  const desktop = makeEnvironment("desktop", true);
  const server = makeEnvironment("server", false, false);
  const resolve = (environment: ReturnType<typeof makeEnvironment>) =>
    resolveProjectSettings(environment.settings, projectId, null, {
      repositoryDefaults,
      providers: environment.providers,
    });
  expect(resolve(desktop).settings.defaultModelSelection?.model).toBe("portable-model");
  const resolved = resolve(server);
  expect(resolved.settings.defaultModelSelection).toEqual(server.localModel);
  expect(resolved.sources.defaultModelSelection).toBe("environment");
  expect(resolved.modelDefaultWarning).toContain("no available supporting default instance");
  expect(resolved.settings.defaultThreadEnvMode).toBe("worktree");
  expect(resolved.sources.defaultThreadEnvMode).toBe("mesura");
});
