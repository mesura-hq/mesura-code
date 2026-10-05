import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import type { VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

import type { buttonVariants } from "../ui/button";
import type { DraftId } from "../../composerDraftStore";
import {
  resolveComposerOptionSelections,
  withImplicitFastModeDefault,
} from "./providerOptionState";
import type { ComposerControlSize } from "./ComposerControl";
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  planModeEnabled: boolean;
};

export type ComposerPromptInjectionState = "none" | "ultrathink";

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  planModeEnabled: boolean;
  size?: ComposerControlSize;
  hidden?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  isComposerOwned?: boolean;
};

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

export { withImplicitFastModeDefault };

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const {
    provider,
    model,
    models,
    modelOptions,
    promptInjectionState = "none",
    planModeEnabled,
  } = input;
  if (provider === "opencode") {
    const normalizedModel = normalizeModelSlug(model, provider);
    const modelIsInCatalog = models.some((candidate) => candidate.slug === normalizedModel);
    if (!modelIsInCatalog) {
      const preservedOptions = modelOptions?.filter(
        (option) => planModeEnabled || option.id !== "agent" || option.value !== "plan",
      );
      return {
        provider,
        promptEffort: null,
        modelOptionsForDispatch:
          preservedOptions && preservedOptions.length > 0 ? preservedOptions : undefined,
      };
    }
  }
  const { caps, selections } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  const descriptors = getProviderOptionDescriptors({ caps, selections });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildExplicitProviderOptionSelectionsFromDescriptors(
      descriptors,
      selections,
    ),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

/**
 * Shared props for both traits renderings, or null when the control has
 * nothing to show. The two exported renderers differ by one prop, so they
 * build their own element off this rather than share a component parameter.
 */
function resolveTraitsControlProps(input: TraitsRenderInput) {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    prompt,
    onPromptChange,
    planModeEnabled,
    size,
    hidden,
    triggerVariant,
    triggerClassName,
    isComposerOwned,
  } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  const { selections: resolvedModelOptions } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions: resolvedModelOptions,
      prompt,
      planModeEnabled,
    })
  ) {
    return null;
  }
  return {
    provider,
    ...(instanceId ? { instanceId } : {}),
    models,
    ...(threadRef ? { threadRef } : {}),
    ...(draftId ? { draftId } : {}),
    model,
    modelOptions: resolvedModelOptions,
    prompt,
    onPromptChange,
    planModeEnabled,
    ...(size !== undefined ? { size } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
    ...(triggerVariant !== undefined ? { triggerVariant } : {}),
    ...(triggerClassName !== undefined ? { triggerClassName } : {}),
    ...(isComposerOwned ? { isComposerOwned } : {}),
  };
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  const props = resolveTraitsControlProps(input);
  return props ? <TraitsMenuContent {...props} /> : null;
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  const props = resolveTraitsControlProps(input);
  // The composer's picker is the only one a keybinding may open.
  return props ? <TraitsPicker {...props} respondsToShortcut /> : null;
}
