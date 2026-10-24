import type {
  ModelCapabilities,
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "../../providerModels";
import { withImplicitFastModeDefault } from "./composerProviderState";
import { buildTraitsTriggerDisplay, buildUnavailableModelOptionDescriptors } from "./TraitsPicker";

/**
 * Provider option rules for the combined model picker: which descriptors a
 * model exposes, which one is its inline effort, and how a change rewrites the
 * saved selections and the Claude Ultrathink prefix.
 *
 * The selection and prompt rules mirror `TraitsMenuContent` in
 * `TraitsPicker.tsx` (`getSelectedTraits` and `handleSelectChange`). That
 * upstream menu is no longer mounted in this fork, but it stays unedited so
 * upstream merges stay cheap. When an upstream sync changes those rules,
 * carry the change here too.
 */

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;
type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

export const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";
const ULTRATHINK_PREFIX_PATTERN = /^Ultrathink:\s*/i;

export const UNAVAILABLE_MODEL_OPTIONS_REASON =
  "This model is unavailable, so its saved options cannot change.";

export const ULTRATHINK_IN_BODY_REASON =
  'Your prompt contains "ultrathink" in the text. Remove it to change this option.';

/**
 * The provider-owned select descriptor that the picker edits inline. Each
 * driver names its reasoning control differently; picking the first select
 * would mistake an OpenCode agent or a Cursor context window for effort.
 * A driver missing here, such as an ACP registry agent, has no inline effort;
 * its options stay in More options.
 */
const INLINE_EFFORT_DESCRIPTOR_ID_BY_DRIVER: Readonly<Record<string, string>> = {
  codex: "reasoningEffort",
  grok: "reasoningEffort",
  muse: "reasoningEffort",
  claudeAgent: "effort",
  cursor: "reasoning",
  opencode: "variant",
  pi: "thinking",
};

export function getInlineEffortDescriptorId(provider: ProviderDriverKind): string | null {
  return INLINE_EFFORT_DESCRIPTOR_ID_BY_DRIVER[provider] ?? null;
}

/** The composer's saved selections for a model, with its Normal/Fast default applied. */
export function resolveComposerOptionSelections(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  provider: ProviderDriverKind,
  modelOptions: ProviderOptions | null | undefined,
  planModeEnabled: boolean,
): { caps: ModelCapabilities; selections: ProviderOptions | undefined } {
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  return { caps, selections: withImplicitFastModeDefault(caps, modelOptions) };
}

export interface ProviderOptionStateInput {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  /** False where no prompt can change, such as Settings. Defaults to true. */
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}

export function resolveProviderOptionState(input: ProviderOptionStateInput) {
  const { provider, models, model, prompt, modelOptions, planModeEnabled } = input;
  const allowPromptInjectedEffort = input.allowPromptInjectedEffort ?? true;
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  const modelIsUnavailable =
    provider === "opencode" &&
    !models.some((candidate) => candidate.slug === normalizeModelSlug(model, provider));
  const descriptors = modelIsUnavailable
    ? buildUnavailableModelOptionDescriptors(
        planModeEnabled
          ? modelOptions
          : modelOptions?.filter((option) => option.id !== "agent" || option.value !== "plan"),
      )
    : getProviderOptionDescriptors({ caps, selections: modelOptions });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is SelectDescriptor => descriptor.type === "select",
  );
  const effortDescriptorId = getInlineEffortDescriptorId(provider);
  const effortDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === effortDescriptorId) ?? null;
  const extraDescriptors = descriptors.filter((descriptor) => descriptor !== effortDescriptor);
  // Prompt-controlled effort belongs to the provider's effort control. A
  // driver without a known effort id keeps the traits menu's first-select rule.
  const promptEffortDescriptor = effortDescriptor ?? selectDescriptors[0] ?? null;

  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (promptEffortDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  // "ultrathink" typed in the body, not just in our prefix, pins the effort.
  const ultrathinkInBodyText =
    ultrathinkPromptControlled &&
    isClaudeUltrathinkPrompt(prompt.replace(ULTRATHINK_PREFIX_PATTERN, ""));
  const promptEffortValue = getProviderOptionCurrentValue(promptEffortDescriptor);
  const effort = ultrathinkPromptControlled
    ? "ultrathink"
    : typeof promptEffortValue === "string"
      ? promptEffortValue
      : null;

  return {
    descriptors,
    promptEffortDescriptor,
    effortDescriptor,
    extraDescriptors,
    effort,
    allowPromptInjectedEffort,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    modelIsUnavailable,
  };
}

export type ProviderOptionState = ReturnType<typeof resolveProviderOptionState>;

/** Why a descriptor cannot change right now, or null when it can. */
export function getProviderOptionReadOnlyReason(
  state: ProviderOptionState,
  descriptorId: string,
): string | null {
  if (state.modelIsUnavailable) {
    return UNAVAILABLE_MODEL_OPTIONS_REASON;
  }
  if (state.ultrathinkInBodyText && descriptorId === state.promptEffortDescriptor?.id) {
    return ULTRATHINK_IN_BODY_REASON;
  }
  return null;
}

export interface ProviderOptionChange {
  prompt: string;
  /** False when only the prompt changes, so callers keep the saved options. */
  modelOptionsChanged: boolean;
  modelOptions?: ProviderOptions | undefined;
}

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? { ...descriptor, ...(typeof currentValue === "boolean" ? { currentValue } : {}) }
        : { ...descriptor, ...(typeof currentValue === "string" ? { currentValue } : {}) },
  );
}

/**
 * The selections and prompt after setting one descriptor, or null when the
 * change is not allowed. Choosing a prompt-injected value (Claude Ultrathink)
 * only prefixes the prompt; leaving it strips that prefix. Text the user typed
 * is never rewritten.
 */
export function applyProviderOptionChange(
  state: ProviderOptionState,
  input: { descriptorId: string; value: string | boolean; prompt: string },
): ProviderOptionChange | null {
  const descriptor = state.descriptors.find((candidate) => candidate.id === input.descriptorId);
  if (!descriptor || getProviderOptionReadOnlyReason(state, descriptor.id) !== null) {
    return null;
  }
  const isPromptEffort = descriptor.id === state.promptEffortDescriptor?.id;
  if (descriptor.type === "select") {
    if (typeof input.value !== "string" || input.value.length === 0) return null;
    if (descriptor.promptInjectedValues?.includes(input.value)) {
      if (!state.allowPromptInjectedEffort) return null;
      return {
        prompt:
          input.prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(input.prompt, input.value),
        modelOptionsChanged: false,
      };
    }
  } else if (typeof input.value !== "boolean") {
    return null;
  }
  return {
    prompt:
      isPromptEffort && state.ultrathinkPromptControlled
        ? input.prompt.replace(ULTRATHINK_PREFIX_PATTERN, "")
        : input.prompt,
    modelOptionsChanged: true,
    modelOptions: buildProviderOptionSelectionsFromDescriptors(
      replaceDescriptorCurrentValue(state.descriptors, descriptor.id, input.value),
    ),
  };
}

/**
 * The saved effort and traits shown after the model name in the picker
 * trigger, with the composer's Normal/Fast default applied, or undefined when
 * the model has no controls. `reportedModelSelection` labels values the user
 * left at the provider default with the value the provider reported.
 */
export function resolveCombinedPickerTriggerTraits(input: {
  provider: ProviderDriverKind;
  instanceId: ModelSelection["instanceId"];
  models: ReadonlyArray<ServerProviderModel>;
  model: string;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  planModeEnabled: boolean;
}): string | undefined {
  const { selections } = resolveComposerOptionSelections(
    input.models,
    input.model,
    input.provider,
    input.modelOptions,
    input.planModeEnabled,
  );
  const optionState = resolveProviderOptionState({
    provider: input.provider,
    models: input.models,
    model: input.model,
    prompt: input.prompt,
    modelOptions: selections,
    planModeEnabled: input.planModeEnabled,
  });
  if (optionState.descriptors.length === 0) return undefined;
  const { label } = buildTraitsTriggerDisplay({
    provider: input.provider,
    descriptors: optionState.descriptors,
    primarySelectDescriptorId: optionState.promptEffortDescriptor?.id ?? null,
    ultrathinkPromptControlled: optionState.ultrathinkPromptControlled,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
      options: [...(selections ?? [])],
    },
    reportedModelSelection: input.reportedModelSelection,
  });
  return label.length > 0 ? label : undefined;
}
