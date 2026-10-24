import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProviderModel,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { subscribePickerAction } from "../../lib/pickerActionBus";
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import type {
  CombinedPickerCandidate,
  CombinedPickerConfig,
  CombinedPickerSavedSelection,
} from "./combinedPickerState";
import { resolveCombinedPickerTriggerTraits } from "./providerOptionState";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/**
 * Mesura: the composer shows model, effort, provider options, and access in
 * the one combined picker. Upstream's separate traits and access controls stay
 * in the code, unmounted; false restores them, for example while an upstream
 * sync is being repaired.
 */
export const COMPOSER_USES_COMBINED_PICKER: boolean = true;

/**
 * Which of upstream's resting composer blocks still render. The traits block
 * moves into the combined picker; the mode block keeps only the Chat/Plan
 * toggle, so it exists only while plan mode is offered.
 */
export function isComposerRestingBlockShown(
  blockId: string,
  input: { planModeUiEnabled: boolean },
): boolean {
  if (!COMPOSER_USES_COMBINED_PICKER) return true;
  if (blockId === "traits") return false;
  if (blockId === "mode") return input.planModeUiEnabled;
  return true;
}

/** The composer writes one applied choice is made of, in the order they run. */
export interface ComposerPickerApplyEffects {
  /** The composer's model-only change. Returns false when it refused the model. */
  selectModel: (instanceId: ProviderInstanceId, model: string) => boolean;
  /** `setProviderModelOptions` on the composer's draft. */
  setModelOptions: (
    driverKind: ProviderDriverKind,
    options: ProviderOptions | undefined,
    target: { instanceId: ProviderInstanceId; model: string; persistSticky: boolean },
  ) => void;
  setRuntimeMode: (mode: RuntimeMode) => void;
  readPrompt: () => string;
  setPrompt: (prompt: string) => void;
  clearMultipleModels: () => void;
  warn: (title: string, description: string) => void;
  focusComposer: () => void;
}

/**
 * Writes one applied combined-picker choice to the composer, or nothing.
 *
 * A new model goes through the composer's own model-only change first, which
 * runs every thread restriction and writes nothing when it refuses. Only after
 * it accepts does this write the row's options, its access, and the prompt's
 * Ultrathink prefix, through the same draft-store calls the separate traits and
 * access controls used. Returns whether the choice was written.
 */
export function applyCombinedPickerCandidateToComposer(
  candidate: CombinedPickerCandidate,
  effects: ComposerPickerApplyEffects,
): boolean {
  // The prompt changed after the effort was staged and now pins it.
  if (candidate.blockedReason !== undefined) {
    effects.warn("Effort is set by your prompt", candidate.blockedReason);
    effects.focusComposer();
    return false;
  }
  const { instanceId, model } = candidate.modelSelection;
  if (candidate.changesModel && !effects.selectModel(instanceId, model)) {
    // Refused: nothing else may be written.
    effects.focusComposer();
    return false;
  }
  effects.clearMultipleModels();
  // A new model gets the row's complete options, so an optionless draft
  // entry cannot inherit the previous model's. The saved model keeps its
  // options unless this opening edited them.
  if (candidate.changesModel || candidate.optionsEdited) {
    effects.setModelOptions(candidate.driverKind, candidate.completeOptions, {
      instanceId,
      model,
      persistSticky: candidate.optionsEdited,
    });
  }
  if (candidate.runtimeMode !== undefined) {
    effects.setRuntimeMode(candidate.runtimeMode);
  }
  // The prompt changes last, and only after the choice was accepted.
  if (candidate.prompt !== effects.readPrompt()) {
    effects.setPrompt(candidate.prompt);
  }
  effects.focusComposer();
  return true;
}

/**
 * The composer's side of the combined model, effort, options, and access
 * picker: what an opening starts from, how a chosen row is written, and the
 * effort shown in the trigger.
 */
export function useComposerCombinedPicker(input: {
  composerDraftTarget: ComposerThreadTarget;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  /** The model the picker shows as selected (its `model` prop). */
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderOptions | null | undefined;
  reportedModelSelection: ModelSelection | null | undefined;
  prompt: string;
  promptRef: RefObject<string>;
  /** The access the composer shows: draft, then thread, then the configured default. */
  runtimeMode: RuntimeMode;
  planModeEnabled: boolean;
  /** Hides the trigger's effort where the composer hides the model name. */
  compactTrigger: boolean;
  /** Hides the trigger's effort while several models are selected. */
  showsMultipleModels: boolean;
  /** The composer's model-only change. Returns false when it refused the model. */
  selectModel: (
    instanceId: ProviderInstanceId,
    model: string,
    options: { focusComposer: false },
  ) => boolean;
  setRuntimeMode: (mode: RuntimeMode) => void;
  setPrompt: (prompt: string) => void;
  scheduleComposerFocus: () => void;
  /** Leaves multi-model selection, as a plain model choice does. */
  clearMultipleModels: () => void;
  pickerOpen: boolean;
}): {
  config: CombinedPickerConfig;
  triggerAccessory: ReactNode;
  /** Makes the opening that follows start on More options. */
  openOnMoreOptions: () => void;
} {
  const {
    composerDraftTarget,
    promptRef,
    selectModel,
    setRuntimeMode,
    setPrompt,
    scheduleComposerFocus,
    clearMultipleModels,
  } = input;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  // Set when the effort shortcut opens the picker, so it opens on More options.
  // The picker reads it once when it opens; any close clears it, including
  // the composer closing the picker directly when its controls hide.
  const [opensOnMoreOptions, setOpensOnMoreOptions] = useState(false);
  if (!input.pickerOpen && opensOnMoreOptions) setOpensOnMoreOptions(false);

  const readSavedSelection = (): CombinedPickerSavedSelection => ({
    instanceId: input.instanceId,
    model: input.model,
    options: input.modelOptions,
    // Another row starts from what a model-only change would restore for it:
    // its remembered options, or its defaults.
    rememberedOptions: (instanceId, model) => {
      const remembered =
        useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.[model];
      return remembered !== undefined && remembered.length > 0 ? remembered : undefined;
    },
    reportedModelSelection: input.reportedModelSelection,
    prompt: promptRef.current,
    runtimeMode: input.runtimeMode,
  });

  const config: CombinedPickerConfig = {
    readSavedSelection,
    readCurrentPrompt: () => promptRef.current,
    context: { planModeEnabled: input.planModeEnabled, allowPromptInjectedEffort: true },
    onApply: (candidate) =>
      applyCombinedPickerCandidateToComposer(candidate, {
        selectModel: (instanceId, model) =>
          selectModel(instanceId, model, { focusComposer: false }),
        setModelOptions: (driverKind, options, target) =>
          setProviderModelOptions(composerDraftTarget, driverKind, options, target),
        setRuntimeMode,
        readPrompt: () => promptRef.current,
        setPrompt,
        clearMultipleModels,
        warn: (title, description) => toastManager.add({ type: "warning", title, description }),
        focusComposer: scheduleComposerFocus,
      }),
    initialExtrasExpanded: opensOnMoreOptions,
    respondsToShortcut: true,
  };

  const triggerTraits = useMemo(
    () =>
      resolveCombinedPickerTriggerTraits({
        provider: input.driverKind,
        instanceId: input.instanceId,
        models: input.models,
        model: input.model,
        prompt: input.prompt,
        modelOptions: input.modelOptions,
        reportedModelSelection: input.reportedModelSelection,
        planModeEnabled: input.planModeEnabled,
      }),
    [
      input.driverKind,
      input.instanceId,
      input.model,
      input.modelOptions,
      input.models,
      input.planModeEnabled,
      input.prompt,
      input.reportedModelSelection,
    ],
  );
  const triggerAccessory =
    triggerTraits && !input.showsMultipleModels ? (
      <span
        data-chat-provider-model-picker-traits="true"
        className={cn(
          "min-w-0 max-w-24 shrink truncate text-muted-foreground",
          input.compactTrigger && "@max-[640px]/composer-surface:hidden",
        )}
      >
        {triggerTraits}
      </span>
    ) : null;

  const openOnMoreOptions = useCallback(() => setOpensOnMoreOptions(true), []);

  return { config, triggerAccessory, openOnMoreOptions };
}

/**
 * The effort shortcut (`traitsPicker.toggle`, which ChatView dispatches as the
 * `traits` picker action) opens the closed picker on More options. While the
 * picker is open, the picker itself owns the shortcut and toggles that screen.
 */
export function useOpenCombinedPickerOnEffortShortcut(input: {
  enabled: boolean;
  openOnMoreOptions: () => void;
  openPicker: () => void;
}) {
  const { enabled, openOnMoreOptions, openPicker } = input;
  useEffect(() => {
    if (!enabled) return;
    return subscribePickerAction("traits", () => {
      openOnMoreOptions();
      openPicker();
    });
  }, [enabled, openOnMoreOptions, openPicker]);
}
