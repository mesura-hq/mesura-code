import {
  type ModelSelection,
  type ServerProvider,
  defaultInstanceIdForDriver,
  PROJECT_FILE_BACKED_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectFileBackedSettingKey,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ResolvedServerSettings,
  type ServerSettings,
  type T3ProjectFile,
  type ThreadEnvMode,
  type WorktreeCleanupRules,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "./model.ts";
import type { RepositoryDefaults } from "./t3ProjectFile.ts";
import { isModelSelectionProviderEnabled } from "./serverSettings.ts";

/**
 * Where a project-scoped value came from. The order is the priority order:
 * a project override, then the environment value, then the repository's
 * t3.json for keys in `PROJECT_FILE_BACKED_SETTINGS`, then the built-in
 * default (reported as "environment", since that is what the environment
 * value is when nothing set it).
 *
 * Mesura: "mesura" marks a value from the checkout's `.mesura.json`, which
 * outranks every tier above. Only new-thread callers that pass repository
 * defaults ever see it.
 */
export type ProjectSettingSource = "environment" | "project" | "t3.json" | "mesura";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectSettings<Settings extends ServerSettings = ServerSettings> {
  /** Environment settings with the project's overrides applied. */
  readonly settings: Settings;
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
    // A forward-compatible decode can leave an unknown value as a present
    // undefined; that is not an override.
    if (Object.values(entry).some((value) => value !== undefined)) return true;
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
 */
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  // Nullable, not just optional: the mobile new-task flow passes its selected
  // project straight through, and that is null until the shell snapshot lands.
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings;
/**
 * With the checkout's decoded t3.json (or null for a missing or invalid
 * one), every file-backed key resolves to a concrete value: the file fills
 * keys whose project and environment tiers are both unset, and the built-in
 * default fills what is left.
 */
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project: LegacyProjectSettingsFields | null | undefined,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings<ResolvedServerSettings>;
/**
 * Mesura: new-thread callers pass the checkout's repository defaults and the
 * owning environment's provider catalog. The legacy t3.json inside them feeds
 * the file tier above; `.mesura.json` fields then outrank project overrides,
 * and its portable model resolves against this environment's providers.
 */
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project: LegacyProjectSettingsFields | null | undefined,
  repository: RepositoryProjectSettingsInput,
): ResolvedProjectSettings<ResolvedServerSettings>;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
  projectFileOrRepository?: T3ProjectFile | RepositoryProjectSettingsInput | null,
): ResolvedProjectSettings {
  const resolved = resolveProjectOverrides(settings, projectId, project);
  if (projectFileOrRepository === undefined) return resolved;
  if (!isRepositoryProjectSettingsInput(projectFileOrRepository)) {
    return applyProjectFile(resolved, projectFileOrRepository);
  }
  return applyRepositoryDefaults(
    settings,
    applyProjectFile(resolved, projectFileOrRepository.repositoryDefaults.projectFile),
    projectFileOrRepository,
  );
}

/** Mesura: the repository defaults a new thread resolves against. */
export interface RepositoryProjectSettingsInput {
  readonly repositoryDefaults: RepositoryDefaults;
  readonly providers: ReadonlyArray<ServerProvider>;
}

function isRepositoryProjectSettingsInput(
  value: T3ProjectFile | RepositoryProjectSettingsInput | null,
): value is RepositoryProjectSettingsInput {
  return value !== null && Object.hasOwn(value, "repositoryDefaults");
}

function applyRepositoryDefaults(
  settings: ServerSettings,
  resolved: ResolvedProjectSettings,
  { repositoryDefaults, providers }: RepositoryProjectSettingsInput,
): ResolvedProjectSettings {
  const effective = { ...resolved.settings };
  const sources = { ...resolved.sources };
  // A legacy t3.json value already arrived through the file tier, under
  // upstream's priority. Only `.mesura.json` outranks a project override.
  const workspace = repositoryDefaults.defaultThreadEnvMode;
  if (workspace.value !== undefined && workspace.source === "mesura") {
    effective.defaultThreadEnvMode = workspace.value;
    sources.defaultThreadEnvMode = "mesura";
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

function applyProjectFile(
  resolved: ResolvedProjectSettings,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings {
  let effective: Record<string, unknown> | null = null;
  let sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> | null = null;
  for (const key of Object.keys(PROJECT_FILE_BACKED_SETTINGS) as ProjectFileBackedSettingKey[]) {
    if (resolved.settings[key] !== null) continue;
    const { value, source } = resolveProjectFileBackedSetting(key, null, projectFile);
    effective ??= { ...resolved.settings };
    sources ??= { ...resolved.sources };
    effective[key] = value;
    // A project override of null defers like an unset one, so the value did
    // not come from the project either way.
    sources[key] = source;
  }
  return effective === null || sources === null
    ? resolved
    : { ...resolved, settings: effective as ServerSettings, sources };
}

/**
 * The file and built-in tiers for one key, given the project-over-environment
 * value (`null` when neither is set). For callers that hold the settings tier
 * but only see the file later, such as the git driver reading the t3.json of
 * the checkout it just created. Same chain as `resolveProjectSettings`.
 */
export function resolveProjectFileBackedSetting<K extends ProjectFileBackedSettingKey>(
  key: K,
  setting: ServerSettings[K],
  projectFile: T3ProjectFile | null,
): { value: ResolvedServerSettings[K]; source: ProjectSettingSource } {
  if (setting !== null) {
    return { value: setting as ResolvedServerSettings[K], source: "environment" };
  }
  const { field, builtIn } = PROJECT_FILE_BACKED_SETTINGS[key];
  const fromFile = projectFile?.[field] as ResolvedServerSettings[K] | undefined;
  return fromFile === undefined
    ? { value: builtIn as ResolvedServerSettings[K], source: "environment" }
    : { value: fromFile, source: "t3.json" };
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
    // A forward-compatible decode leaves an unknown value as a present
    // undefined; that is not an override.
    if (value === undefined) continue;
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

/** Worktree rules are project-scoped; artifact and log retention stays environment-wide. */
export function resolveWorktreeCleanup(
  settings: ServerSettings,
  projectId: ProjectId | null,
): WorktreeCleanupRules {
  const policy = resolveProjectSettings(settings, projectId).settings.worktreeCleanup;
  if (policy?.mode === "custom") return policy.rules;
  if (policy?.mode === "off")
    return {
      worktreeAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  const { worktreeAfterDays, worktreeOnMerge, worktreeOnDelete, worktreeUnchanged } =
    settings.storageCleanup;
  return { worktreeAfterDays, worktreeOnMerge, worktreeOnDelete, worktreeUnchanged };
}
