import {
  type ModelSelection,
  type ServerProvider,
  defaultInstanceIdForDriver,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ServerSettings,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "./model.ts";
import type { RepositoryDefaults } from "./t3ProjectFile.ts";
import { isModelSelectionProviderEnabled } from "./serverSettings.ts";

export type ProjectSettingSource = "environment" | "project" | "mesura" | "t3";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectSettings {
  /** Environment settings with the project's overrides applied. */
  readonly settings: ServerSettings;
  /** Where each scopable key's effective value came from. */
  readonly sources: ProjectSettingSources;
  /** The project's raw override entry; `{}` when it has none. */
  readonly overrides: ProjectSettingsOverrides;
  readonly modelDefaultWarning?: string;
}

const EMPTY_OVERRIDES: ProjectSettingsOverrides = {};

const ENVIRONMENT_SOURCES: ProjectSettingSources = Object.fromEntries(
  PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "environment"]),
) as Record<ProjectScopedServerSettingKey, ProjectSettingSource>;

/** Cheap check so hot paths skip the projectId lookup when nothing is overridden. */
export function hasProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): boolean {
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    if (Object.keys(entry).length > 0) return true;
  }
  return false;
}

/**
 * The project aggregate's own model and workspace fields. They remain the
 * source of truth until the server has folded them into the override record;
 * after the fold the record alone decides, so a reset there cannot be undone
 * by a stale aggregate value.
 */
export interface LegacyProjectSettingsFields {
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
}

/**
 * Apply one project's overrides on top of environment settings. A model
 * override whose provider is disabled on this environment falls back to the
 * environment value, the same guard the environment-level selection gets.
 * New-thread callers pass repository defaults and the owning environment catalog.
 * Mesura fields outrank project overrides; legacy t3 fields fill only unset project keys.
 */
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  // Nullable, not just optional: the mobile new-task flow passes its selected
  // project straight through, and that is null until the shell snapshot lands.
  project?: LegacyProjectSettingsFields | null,
  repository?: {
    readonly repositoryDefaults: RepositoryDefaults;
    readonly providers: ReadonlyArray<ServerProvider>;
  },
): ResolvedProjectSettings {
  const resolved = resolveProjectOverrides(settings, projectId, project);
  if (!repository) return resolved;
  const { repositoryDefaults, providers } = repository;
  const effective = { ...resolved.settings };
  const sources = { ...resolved.sources };
  const workspace = repositoryDefaults.defaultThreadEnvMode;
  if (
    workspace.value !== undefined &&
    (workspace.source === "mesura" || sources.defaultThreadEnvMode !== "project")
  ) {
    effective.defaultThreadEnvMode = workspace.value;
    sources.defaultThreadEnvMode = workspace.source;
  }
  const portable = repositoryDefaults.defaultModelSelection.value;
  if (portable !== undefined) {
    const usableProviders = providers.filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.auth.status !== "unauthenticated" &&
        provider.availability !== "unavailable",
    );
    const provider = usableProviders.find(
      (candidate) =>
        candidate.driver === portable.provider &&
        candidate.instanceId === defaultInstanceIdForDriver(portable.provider),
    );
    const model = provider?.models.find(
      (candidate) => candidate.slug === portable.model && !candidate.isLegacy,
    );
    if (provider && model) {
      const supportedOptions = portable.options?.filter((selection) => {
        const descriptor = model.capabilities?.optionDescriptors?.find(
          (option) => option.id === selection.id,
        );
        return descriptor?.type === "boolean"
          ? typeof selection.value === "boolean"
          : descriptor?.options.some((option) => option.id === selection.value) === true;
      });
      const options = buildExplicitProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({
          caps: model.capabilities ?? {},
          selections: supportedOptions,
        }),
        supportedOptions,
      );
      effective.defaultModelSelection = {
        instanceId: provider.instanceId,
        model: model.slug,
        ...(options ? { options } : {}),
      };
      sources.defaultModelSelection = "mesura";
    } else {
      const isUsable = (selection: ModelSelection | null): selection is ModelSelection =>
        selection !== null &&
        usableProviders.some(
          (candidate) =>
            candidate.instanceId === selection.instanceId &&
            candidate.models.some((model) => model.slug === selection.model && !model.isLegacy),
        );
      // Validate every fallback against this environment's catalog. A stale local
      // default must not turn a rejected portable model into another unavailable pick.
      if (!isUsable(effective.defaultModelSelection)) {
        effective.defaultModelSelection = isUsable(settings.defaultModelSelection)
          ? settings.defaultModelSelection
          : null;
        sources.defaultModelSelection = "environment";
        if (effective.defaultModelSelection === null) {
          const candidates = usableProviders.flatMap((candidate) =>
            candidate.models
              .filter(
                (model) =>
                  !model.isLegacy &&
                  (candidate.driver !== portable.provider || model.slug !== portable.model),
              )
              .map((model) => ({ provider: candidate, model })),
          );
          const fallback =
            candidates.find((candidate) => candidate.model.isDefault) ?? candidates[0];
          if (fallback) {
            effective.defaultModelSelection = {
              instanceId: fallback.provider.instanceId,
              model: fallback.model.slug,
            };
          }
        }
      }
      return {
        ...resolved,
        settings: effective,
        sources,
        modelDefaultWarning: `Repository model ${portable.provider}/${portable.model} has no available supporting default instance; using the new-thread fallback.`,
      };
    }
  }
  return { ...resolved, settings: effective, sources };
}

function resolveProjectOverrides(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings {
  const stored = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  const overrides: ProjectSettingsOverrides =
    project == null || settings.projectSettingsFolded
      ? (stored ?? EMPTY_OVERRIDES)
      : {
          ...(project.defaultModelSelection != null
            ? { defaultModelSelection: project.defaultModelSelection }
            : {}),
          ...(project.defaultThreadEnvMode != null
            ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
            : {}),
          ...stored,
        };
  if (Object.keys(overrides).length === 0) {
    return { settings, sources: ENVIRONMENT_SOURCES, overrides: EMPTY_OVERRIDES };
  }
  const sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> = {
    ...ENVIRONMENT_SOURCES,
  };
  const effective: Record<string, unknown> = { ...settings };
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    // A model on a disabled provider falls back to the environment, like the
    // environment-level guards do for these keys.
    if (
      (key === "textGenerationModelSelection" || key === "defaultModelSelection") &&
      value !== undefined &&
      value !== null &&
      !isModelSelectionProviderEnabled(settings, value as ModelSelection)
    ) {
      continue;
    }
    effective[key] = value;
    sources[key] = "project";
  }
  return { settings: effective as ServerSettings, sources, overrides };
}

/** Replace the project's entry, dropping it entirely when nothing is overridden. */
export function withProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  next: ProjectSettingsOverrides | null,
): ServerSettings["projectSettingsOverrides"] {
  const { [projectId]: _removed, ...rest } = settings.projectSettingsOverrides;
  return next === null || Object.keys(next).length === 0 ? rest : { ...rest, [projectId]: next };
}

/** The project's entry with `keys` removed; `null` when that leaves it empty. */
export function clearProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  keys: readonly ProjectScopedServerSettingKey[],
): ProjectSettingsOverrides | null {
  const current = settings.projectSettingsOverrides[projectId];
  if (current === undefined) return null;
  const next = { ...current };
  for (const key of keys) delete next[key];
  return Object.keys(next).length === 0 ? null : next;
}
