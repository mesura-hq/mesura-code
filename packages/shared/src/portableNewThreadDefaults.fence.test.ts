import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProjectSettings } from "./projectSettings.ts";
import { resolveRepositoryDefaults } from "./t3ProjectFile.ts";

const projectId = ProjectId.make("portable-project");
const localModel = { instanceId: ProviderInstanceId.make("codex_local"), model: "local-model" };
const environmentModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "environment-model",
};

const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  defaultThreadEnvMode: "local" as const,
  defaultModelSelection: environmentModel,
  providerInstances: {
    codex: { driver: "codex" },
    codex_local: { driver: "codex" },
    codex_remote: { driver: "codex" },
  },
  projectSettingsOverrides: {
    [projectId]: {
      defaultThreadEnvMode: "local" as const,
      defaultModelSelection: localModel,
    },
  },
};

const providers = [
  {
    instanceId: "codex_local",
    driver: "codex",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: [{ slug: "local-model", name: "Local model", isCustom: false, capabilities: null }],
  },
  {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: [
      {
        slug: "environment-model",
        name: "Environment model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "portable-model",
        name: "Portable model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [{ id: "high", label: "High", isDefault: true }],
            },
          ],
        },
      },
    ],
  },
] as unknown as ServerConfig["providers"];

function repositoryDefaults(input: {
  readonly defaultThreadEnvMode?: "local" | "worktree";
  readonly defaultModelSelection?: {
    readonly provider: "codex";
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  };
}) {
  const { defaultModelSelection, ...fields } = input;
  return resolveRepositoryDefaults(
    {
      version: 1,
      ...fields,
      ...(defaultModelSelection
        ? {
            defaultModelSelection: {
              ...defaultModelSelection,
              provider: ProviderDriverKind.make(defaultModelSelection.provider),
            },
          }
        : {}),
    },
    null,
  );
}

describe("phase 2 portable new-thread defaults", () => {
  it("P2 RED repository fields beat local project values on the owning environment", () => {
    const resolved = resolveProjectSettings(settings, projectId, null, {
      repositoryDefaults: repositoryDefaults({ defaultThreadEnvMode: "worktree" }),
      providers,
    });

    expect(resolved.settings.defaultThreadEnvMode).toBe("worktree");
    expect(resolved.sources.defaultThreadEnvMode).toBe("mesura");
    expect(resolved.settings.defaultModelSelection).toEqual(localModel);
  });

  it("P2 RED portable models bind to an available instance and retain supported options", () => {
    const resolved = resolveProjectSettings(settings, projectId, null, {
      repositoryDefaults: repositoryDefaults({
        defaultModelSelection: {
          provider: "codex",
          model: "portable-model",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "unsupportedOption", value: "ignored" },
          ],
        },
      }),
      providers,
    });

    expect(resolved.settings.defaultModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "portable-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(resolved.sources.defaultModelSelection).toBe("mesura");
  });

  it.each([
    ["unavailable", "missing-model", providers],
    [
      "ambiguous",
      "portable-model",
      [
        providers[0]!,
        {
          ...providers[1]!,
          models: providers[1]!.models.filter((model) => model.slug === "environment-model"),
        },
        { ...providers[1]!, instanceId: ProviderInstanceId.make("codex_remote") },
        { ...providers[1]!, instanceId: ProviderInstanceId.make("codex_other") },
      ],
    ],
  ] as const)(
    "P2 RED %s portable model falls back to a usable environment model",
    (_case, model, availableProviders) => {
      const unsafeLocalSettings = {
        ...settings,
        projectSettingsOverrides: {
          [projectId]: {
            ...settings.projectSettingsOverrides[projectId],
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex_local"),
              model: "removed-model",
            },
          },
        },
      };
      const resolved = resolveProjectSettings(unsafeLocalSettings, projectId, null, {
        repositoryDefaults: repositoryDefaults({
          defaultModelSelection: { provider: "codex", model },
        }),
        providers: availableProviders,
      });
      expect(resolved.settings.defaultModelSelection).toEqual(environmentModel);
      expect(resolved.sources.defaultModelSelection).toBe("environment");
    },
  );

  it("P2 GUARD omitted repository fields preserve the local project values", () => {
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultThreadEnvMode).toBe("local");
    expect(resolved.settings.defaultModelSelection).toEqual(localModel);
    expect(resolved.sources.defaultThreadEnvMode).toBe("project");
  });
  it("P2 implementation ignores unsupported option values instead of replacing them with a catalog default", () => {
    const resolved = resolveProjectSettings(settings, projectId, null, {
      repositoryDefaults: repositoryDefaults({
        defaultModelSelection: {
          provider: "codex",
          model: "portable-model",
          options: [{ id: "reasoningEffort", value: "unknown" }],
        },
      }),
      providers,
    });
    expect(resolved.settings.defaultModelSelection).toEqual({
      instanceId: "codex",
      model: "portable-model",
    });
  });

  it("P2 implementation returns no model when the owning environment has no usable provider", () => {
    const resolved = resolveProjectSettings(settings, projectId, null, {
      repositoryDefaults: repositoryDefaults({
        defaultModelSelection: { provider: "codex", model: "portable-model" },
      }),
      providers: providers.map((provider) => ({ ...provider, enabled: false })),
    });
    expect(resolved.settings.defaultModelSelection).toBeNull();
    expect(resolved.modelDefaultWarning).toContain("no available supporting default instance");
  });
  it("P2 implementation does not use an ambiguous portable model as its own catalog fallback", () => {
    const resolved = resolveProjectSettings(settings, projectId, null, {
      repositoryDefaults: repositoryDefaults({
        defaultModelSelection: { provider: "codex", model: "portable-model" },
      }),
      providers: ["codex_one", "codex_two"].map((instanceId) => ({
        ...providers[1]!,
        instanceId: ProviderInstanceId.make(instanceId),
        models: providers[1]!.models.filter((model) => model.slug === "portable-model"),
      })),
    });
    expect(resolved.settings.defaultModelSelection).toBeNull();
  });
});
