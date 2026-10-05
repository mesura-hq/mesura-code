import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "../../providerModels";
import { NO_PROVIDER_MODEL_SELECTION, type ProviderInstanceEntry } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type {
  CombinedPickerCandidate,
  CombinedPickerConfig,
  CombinedPickerSavedSelection,
} from "../chat/combinedPickerState";
import type { ModelEsque } from "../chat/providerIconUtils";
import { resolveTraitsTriggerDisplay } from "../chat/TraitsPicker";
import { toastManager } from "../ui/toast";
import {
  createSettingsPickerContext,
  keepLegacyCodexFast,
  planSettingsPickerApply,
  presentLegacyCodexFast,
  retainUnadvertisedSavedOptions,
  type SettingsPickerKind,
} from "./combinedPickerSettings";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

export interface SettingsPickerChange {
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
}

/**
 * The shared combined picker as a Settings control. It opens on the
 * representative target's saved selection, applies a choice only after every
 * selected target accepts its model, and hands the caller only the fields this
 * opening deliberately changed.
 */
export function CombinedPickerSettings(props: {
  kind: SettingsPickerKind;
  /**
   * The representative target's selection, with its options as stored. Null
   * when no provider is selectable; new-thread defaults still edit access.
   */
  selection: ModelSelection | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  planModeEnabled: boolean;
  mixedModel: boolean;
  /** New-thread defaults only: the representative's access and whether targets disagree. */
  runtimeMode?: RuntimeMode;
  runtimeModeMixed?: boolean;
  /** Replaces the model label, for a row whose subject is not the model. */
  triggerLabel?: string;
  triggerAriaLabel?: string;
  /** Open with More options expanded, for the Permissions row. */
  opensOnExtras?: boolean;
  rejectedTitle: string;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  onChange: (change: SettingsPickerChange) => void;
}) {
  const {
    kind,
    planModeEnabled,
    runtimeMode,
    runtimeModeMixed,
    opensOnExtras,
    rejectedTitle,
    getModelDisabledReason,
    onChange,
    instanceEntries,
  } = props;
  const stored = props.selection ?? NO_PROVIDER_MODEL_SELECTION;
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === stored.instanceId);
  const legacyFast = activeEntry
    ? presentLegacyCodexFast({
        driverKind: activeEntry.driverKind,
        models: activeEntry.models,
        selection: stored,
      })
    : null;
  const legacyFastTier = legacyFast?.tier ?? null;
  // What the picker shows and edits; `stored` stays the reference for what
  // an unrelated edit must preserve.
  const shown = legacyFast?.shown ?? stored;
  const pickerEntries = legacyFast
    ? instanceEntries.map((entry) =>
        entry === activeEntry ? { ...entry, models: legacyFast.models } : entry,
      )
    : instanceEntries;
  const apply = (candidate: CombinedPickerCandidate) => {
    const plan = planSettingsPickerApply({ kind, candidate, getModelDisabledReason });
    if (plan.kind === "rejected") {
      toastManager.add({ type: "error", title: rejectedTitle, description: plan.reason });
      return;
    }
    if (plan.kind === "unchanged") return;
    const appliedEntry = plan.modelSelection
      ? instanceEntries.find((entry) => entry.instanceId === plan.modelSelection?.instanceId)
      : undefined;
    const modelSelection =
      plan.modelSelection && appliedEntry
        ? keepLegacyCodexFast(
            retainUnadvertisedSavedOptions(
              plan.modelSelection,
              stored,
              new Set(
                getProviderModelCapabilities(
                  appliedEntry.models,
                  plan.modelSelection.model,
                  appliedEntry.driverKind,
                ).optionDescriptors?.map((descriptor) => descriptor.id),
              ),
            ),
            stored,
            legacyFastTier,
          )
        : plan.modelSelection;
    onChange({
      ...(modelSelection ? { modelSelection } : {}),
      ...(plan.runtimeMode ? { runtimeMode: plan.runtimeMode } : {}),
    });
  };
  // Rebuilt each render; the picker reads it once per opening.
  const combined: CombinedPickerConfig = {
    readSavedSelection: (): CombinedPickerSavedSelection => ({
      instanceId: shown.instanceId,
      model: shown.model,
      modelOptionsByInstance: { [shown.instanceId]: shown.options ?? [] },
      // Settings have no prompt; the context refuses prompt-injected values.
      prompt: "",
      runtimeMode: runtimeMode ?? DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      runtimeModeMixed: runtimeModeMixed === true,
    }),
    readCurrentPrompt: () => "",
    context: createSettingsPickerContext(kind, { planModeEnabled }),
    onApply: apply,
    // Access never depends on a model row: an access-only apply writes the
    // access default alone, even when no row is visible to apply.
    ...(kind === "new-thread-defaults"
      ? { onApplyAccess: (mode: RuntimeMode) => onChange({ runtimeMode: mode }) }
      : {}),
    ...(opensOnExtras ? { initialExtrasExpanded: true } : {}),
  };
  const triggerTraits =
    activeEntry && !props.mixedModel
      ? resolveTraitsTriggerDisplay({
          provider: activeEntry.driverKind,
          models: legacyFast?.models ?? activeEntry.models,
          model: shown.model,
          prompt: "",
          modelOptions: shown.options,
          planModeEnabled,
        })
      : undefined;
  const triggerLabel = props.triggerLabel ?? (props.mixedModel ? "Mixed" : undefined);

  return (
    <ProviderModelPicker
      activeInstanceId={shown.instanceId}
      model={shown.model}
      lockedProvider={null}
      instanceEntries={pickerEntries}
      modelOptionsByInstance={props.modelOptionsByInstance}
      triggerVariant="outline"
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      {...(triggerLabel !== undefined ? { triggerLabel } : {})}
      {...(props.triggerAriaLabel ? { triggerAriaLabel: props.triggerAriaLabel } : {})}
      {...(triggerTraits ? { triggerTraits } : {})}
      {...(props.onOpenProviderSetup ? { onOpenProviderSetup: props.onOpenProviderSetup } : {})}
      getModelDisabledReason={getModelDisabledReason}
      // Reached only when a row has no exact instance entry to resolve.
      onInstanceModelChange={(instanceId, model) =>
        combined.onApply({
          modelSelection: createModelSelection(instanceId, model),
          prompt: "",
          selectionEdited: true,
          appliedFrom: "row",
        })
      }
      combined={combined}
    />
  );
}
