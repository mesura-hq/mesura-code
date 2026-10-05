import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeMode,
  ServerProviderModel,
} from "@t3tools/contracts";

import { resolveSelectableModel } from "@t3tools/shared/model";

import type { CombinedPickerCandidate, CombinedPickerContext } from "../chat/combinedPickerState";

/**
 * How the shared combined picker saves in Settings. New-thread defaults edit a
 * model and an independent access default. Background writing (text
 * generation and source-control writing) edits a model only: its task decides
 * access, and it reads only some of the options a chat model advertises.
 */
export type SettingsPickerKind =
  | "new-thread-defaults"
  | "text-generation"
  | "source-control-writing";

export const SETTINGS_ACCESS_MANAGED_BY_TASK_LABEL = "Managed by task";

const UNCONSUMED_OPTION_REASON = "Not used for generated text, so it cannot change here.";

/**
 * The options each text-generation service reads from its ModelSelection.
 * Read-only backend sources, under apps/server/src:
 * - Codex: textGeneration/CodexTextGeneration.ts (reasoningEffort, and
 *   serviceTier through getCodexServiceTierOptionValue, which maps legacy fastMode)
 * - Claude: textGeneration/ClaudeTextGeneration.ts (effort, thinking, fastMode;
 *   contextWindow through the resolved catalog model)
 * - Cursor: textGeneration/CursorTextGeneration.ts via
 *   provider/acp/CursorAcpSupport.ts resolveCursorAcpConfigUpdates
 * - Grok: textGeneration/GrokTextGeneration.ts (reasoningEffort)
 * - OpenCode: textGeneration/OpenCodeTextGeneration.ts (agent, variant)
 * - Antigravity: textGeneration/AntigravityTextGeneration.ts (model only)
 * Update this table when one of those services starts reading another option.
 */
const WRITING_CONSUMED_OPTION_IDS: Readonly<Record<string, ReadonlySet<string>>> = {
  codex: new Set(["reasoningEffort", "serviceTier", "fastMode"]),
  claudeAgent: new Set(["effort", "thinking", "fastMode", "contextWindow"]),
  cursor: new Set(["reasoning", "contextWindow", "fastMode", "thinking"]),
  grok: new Set(["reasoningEffort"]),
  opencode: new Set(["variant", "agent"]),
  antigravity: new Set(),
};

/** Why a background-writing setting cannot save this option, or null when its service reads it. */
export function getWritingSettingsOptionReadOnlyReason(
  driverKind: ProviderDriverKind,
  descriptorId: string,
): string | null {
  return WRITING_CONSUMED_OPTION_IDS[driverKind]?.has(descriptorId)
    ? null
    : UNCONSUMED_OPTION_REASON;
}

/** The combined picker context for one Settings section. No Settings action edits a prompt. */
export function createSettingsPickerContext(
  kind: SettingsPickerKind,
  options: { planModeEnabled: boolean },
): CombinedPickerContext {
  if (kind === "new-thread-defaults") {
    return { planModeEnabled: options.planModeEnabled, allowPromptInjectedEffort: false };
  }
  return {
    planModeEnabled: options.planModeEnabled,
    allowPromptInjectedEffort: false,
    optionReadOnlyReason: getWritingSettingsOptionReadOnlyReason,
    accessReadOnlyLabel: SETTINGS_ACCESS_MANAGED_BY_TASK_LABEL,
  };
}

export type SettingsPickerApplyPlan =
  | { kind: "unchanged" }
  | { kind: "rejected"; reason: string }
  | { kind: "write"; modelSelection?: ModelSelection; runtimeMode?: RuntimeMode };

/**
 * Which fields one applied opening deliberately changed. A row click or Enter
 * chooses that model; Use changes the model only when the row differs from the
 * saved one or its options were edited, so an access-only edit keeps a Mixed
 * or inherited model. A changed model must be available on every target, or
 * nothing is written.
 */
export function planSettingsPickerApply(input: {
  kind: SettingsPickerKind;
  candidate: CombinedPickerCandidate;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
}): SettingsPickerApplyPlan {
  const { candidate } = input;
  if (candidate.blockedReason) return { kind: "rejected", reason: candidate.blockedReason };
  const modelChanged = candidate.appliedFrom !== "use" || candidate.selectionEdited;
  const runtimeMode = input.kind === "new-thread-defaults" ? candidate.runtimeMode : undefined;
  if (modelChanged) {
    const reason = input.getModelDisabledReason(
      candidate.modelSelection.instanceId,
      candidate.modelSelection.model,
    );
    if (reason) return { kind: "rejected", reason };
  }
  if (!modelChanged && runtimeMode === undefined) return { kind: "unchanged" };
  return {
    kind: "write",
    ...(modelChanged ? { modelSelection: candidate.modelSelection } : {}),
    ...(runtimeMode !== undefined ? { runtimeMode } : {}),
  };
}

/**
 * Saved options the applied model does not advertise, such as Codex's legacy
 * `fastMode` that the backend still maps to a service tier, never appear in
 * the picker. Keep them when the same model is applied again, so an unrelated
 * edit does not silently drop a value its service still reads.
 */
export function retainUnadvertisedSavedOptions(
  applied: ModelSelection,
  saved: ModelSelection,
  advertisedOptionIds: ReadonlySet<string>,
): ModelSelection {
  if (applied.instanceId !== saved.instanceId || applied.model !== saved.model) return applied;
  const appliedIds = new Set((applied.options ?? []).map((option) => option.id));
  const retained = (saved.options ?? []).filter(
    (option) => !advertisedOptionIds.has(option.id) && !appliedIds.has(option.id),
  );
  return retained.length === 0
    ? applied
    : { ...applied, options: [...(applied.options ?? []), ...retained] };
}

/**
 * The resolved selection with its options as stored, while it still names the
 * stored instance and model. Selection normalization keeps only advertised
 * options, which would drop values the picker must carry through, such as a
 * legacy Codex `fastMode`.
 */
export function withStoredOptions(
  resolved: ModelSelection,
  stored: ModelSelection | null | undefined,
): ModelSelection {
  if (!stored || stored.instanceId !== resolved.instanceId || stored.model !== resolved.model) {
    return resolved;
  }
  return stored.options === undefined
    ? { instanceId: resolved.instanceId, model: resolved.model }
    : { ...resolved, options: stored.options };
}

/** The tier the Codex backend runs a legacy `fastMode: true` selection on. */
const LEGACY_CODEX_FAST_TIER_ID = "fast";
const LEGACY_CODEX_FAST_LABEL = "Fast (legacy)";

export interface LegacyCodexFastPresentation {
  /** The service tier that stands for the legacy value in the picker. */
  tier: string;
  /** The stored selection with that tier selected. */
  shown: ModelSelection;
  /** The instance's catalog, with a display-only legacy tier when none is Fast. */
  models: ReadonlyArray<ServerProviderModel>;
}

/**
 * How the Settings picker shows a saved legacy Codex Fast selection, or null
 * when the selection is not one. The Codex backend reads `fastMode: true`
 * without an explicit `serviceTier` as the "fast" tier
 * (apps/server/src/codexModelOptions.ts, getCodexServiceTierOptionValue); an
 * explicit `serviceTier` wins over it. The picker selects the advertised fast
 * tier (id `fast`, or labelled Fast as the traits trigger reads it). A custom
 * catalog may list neither; the model's service tier then gains a selected,
 * display-only "Fast (legacy)" entry, so the control neither claims Standard
 * nor loses the way back to it. `keepLegacyCodexFast` keeps that entry out of
 * saved options.
 */
export function presentLegacyCodexFast(input: {
  driverKind: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  selection: ModelSelection;
}): LegacyCodexFastPresentation | null {
  const options = input.selection.options ?? [];
  if (
    input.driverKind !== "codex" ||
    !options.some((option) => option.id === "fastMode" && option.value === true) ||
    options.some((option) => option.id === "serviceTier")
  ) {
    return null;
  }
  const slug = resolveSelectableModel(input.driverKind, input.selection.model, input.models);
  const model = input.models.find((candidate) => candidate.slug === slug);
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === "serviceTier",
  );
  if (!model || descriptor?.type !== "select") return null;
  const advertised =
    descriptor.options.find((option) => option.id === LEGACY_CODEX_FAST_TIER_ID) ??
    descriptor.options.find((option) => option.label.toLowerCase() === "fast");
  const tier = advertised?.id ?? LEGACY_CODEX_FAST_TIER_ID;
  const shown = { ...input.selection, options: [...options, { id: "serviceTier", value: tier }] };
  if (advertised) return { tier, shown, models: input.models };
  const legacyDescriptor = {
    ...descriptor,
    options: [...descriptor.options, { id: tier, label: LEGACY_CODEX_FAST_LABEL }],
  };
  const legacyModel: ServerProviderModel = {
    ...model,
    capabilities: {
      ...model.capabilities,
      optionDescriptors: (model.capabilities?.optionDescriptors ?? []).map((candidate) =>
        candidate === descriptor ? legacyDescriptor : candidate,
      ),
    },
  };
  return {
    tier,
    shown,
    models: input.models.map((candidate) => (candidate === model ? legacyModel : candidate)),
  };
}

/**
 * Keeps a legacy Fast selection in its stored form when the same model is
 * applied with the tier the picker seeded, so an unrelated edit cannot change
 * its speed. Choosing another tier, such as Standard, writes that tier, which
 * the backend reads over the legacy value.
 */
export function keepLegacyCodexFast(
  applied: ModelSelection,
  stored: ModelSelection,
  legacyFastTier: string | null,
): ModelSelection {
  if (
    legacyFastTier === null ||
    applied.instanceId !== stored.instanceId ||
    applied.model !== stored.model ||
    !applied.options?.some(
      (option) => option.id === "serviceTier" && option.value === legacyFastTier,
    )
  ) {
    return applied;
  }
  const options = applied.options.filter(
    (option) => option.id !== "serviceTier" && option.id !== "fastMode",
  );
  return { ...applied, options: [...options, { id: "fastMode", value: true }] };
}
