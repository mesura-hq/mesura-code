import type {
  ModelCapabilities,
  ProviderDriverKind,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "../../providerModels";

/**
 * Provider option rules shared by the traits menu and the combined model
 * picker: which descriptors a model exposes, which one is its effort, and how
 * a change rewrites the saved selections and the Claude Ultrathink prefix.
 */

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;
type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

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
 */
const INLINE_EFFORT_DESCRIPTOR_ID_BY_DRIVER: Readonly<Record<string, string>> = {
  codex: "reasoningEffort",
  grok: "reasoningEffort",
  claudeAgent: "effort",
  cursor: "reasoning",
  opencode: "variant",
};

export function getInlineEffortDescriptorId(provider: ProviderDriverKind): string | null {
  return INLINE_EFFORT_DESCRIPTOR_ID_BY_DRIVER[provider] ?? null;
}

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = {
  agent: "Agent",
  effort: "Effort",
  reasoningEffort: "Reasoning effort",
  variant: "Reasoning",
};

function savedOptionLabel(id: string): string {
  return (
    SAVED_OPTION_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

/** Read-only descriptors for saved values whose OpenCode model metadata is unavailable. */
export function buildUnavailableModelOptionDescriptors(
  selections: ProviderOptions | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (selections ?? []).map((selection) =>
    typeof selection.value === "boolean"
      ? {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "boolean" as const,
          currentValue: selection.value,
        }
      : {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "select" as const,
          options: [{ id: selection.value, label: selection.value }],
          currentValue: selection.value,
        },
  );
}

/**
 * Cursor ACP can report `fastMode: true` as the provider default. T3 only
 * treats Fast as selected when the user chose it (draft/sticky/settings).
 * Otherwise inject an explicit `false` so new chats stay Normal and the
 * send path can overwrite a prior Fast session — descriptor defaults are
 * otherwise omitted by `buildExplicitProviderOptionSelectionsFromDescriptors`.
 */
export function withImplicitFastModeDefault(
  caps: ModelCapabilities,
  modelOptions: ProviderOptions | null | undefined,
): ProviderOptions | undefined {
  const hasExplicitFastMode = modelOptions?.some((selection) => selection.id === "fastMode");
  if (hasExplicitFastMode) {
    return modelOptions ?? undefined;
  }
  const hasFastModeDescriptor = caps.optionDescriptors?.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
  );
  if (!hasFastModeDescriptor) {
    return modelOptions ?? undefined;
  }
  return [...(modelOptions ?? []), { id: "fastMode", value: false }];
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

function getDescriptorStringValue(descriptor: SelectDescriptor | null): string | null {
  const value = descriptor ? getProviderOptionCurrentValue(descriptor) : undefined;
  return typeof value === "string" ? value : null;
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
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is BooleanDescriptor => descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const effortDescriptorId = getInlineEffortDescriptorId(provider);
  const effortDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === effortDescriptorId) ?? null;
  const extraDescriptors = descriptors.filter((descriptor) => descriptor !== effortDescriptor);
  // Prompt-controlled effort belongs to the provider's effort control. A
  // driver without a known effort id keeps the traits menu's historical
  // first-select rule.
  const promptEffortDescriptor = effortDescriptor ?? primarySelectDescriptor;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (promptEffortDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  // "ultrathink" typed in the body, not just in our prefix, pins the effort.
  const ultrathinkInBodyText =
    ultrathinkPromptControlled &&
    isClaudeUltrathinkPrompt(prompt.replace(ULTRATHINK_PREFIX_PATTERN, ""));
  const effort = ultrathinkPromptControlled
    ? "ultrathink"
    : getDescriptorStringValue(promptEffortDescriptor);

  const showEffort = primarySelectDescriptor !== null;
  const showThinking = thinkingDescriptor !== null;
  const showFastMode = fastModeDescriptor !== null;
  const showContextWindow = contextWindowDescriptor !== null;
  const showAgent = agentDescriptor !== null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    promptEffortDescriptor,
    effortDescriptor,
    extraDescriptors,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled:
      typeof thinkingDescriptor?.currentValue === "boolean"
        ? thinkingDescriptor.currentValue
        : null,
    contextWindow: getDescriptorStringValue(contextWindowDescriptor),
    selectedAgent: getDescriptorStringValue(agentDescriptor),
    selectedAgentLabel: agentDescriptor ? getProviderOptionCurrentLabel(agentDescriptor) : null,
    allowPromptInjectedEffort,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    modelIsUnavailable,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls:
      showEffort ||
      showThinking ||
      showFastMode ||
      showContextWindow ||
      showAgent ||
      (modelIsUnavailable && descriptors.length > 0),
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
