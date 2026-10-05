import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";

import { modelPickerModelKey } from "./modelPickerKeys";
import {
  ULTRATHINK_IN_BODY_REASON,
  ULTRATHINK_PROMPT_PREFIX,
  applyProviderOptionChange,
  getProviderOptionReadOnlyReason,
  resolveComposerOptionSelections,
  resolveProviderOptionState,
  type ProviderOptionState,
} from "./providerOptionState";

/**
 * Pending state of one combined-picker opening. Every row keeps its own
 * effort and option edits, keyed by `modelPickerModelKey(instanceId, slug)`,
 * until the picker applies one row or is dismissed. Dismissal simply drops
 * the state; the next opening starts again from the saved selection.
 */

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/** What the caller has saved when the picker opens. */
export interface CombinedPickerSavedSelection {
  instanceId: ProviderInstanceId;
  model: string;
  /** Saved options per provider instance, as the composer draft stores them. */
  modelOptionsByInstance: Readonly<Partial<Record<string, ProviderOptions>>> | null | undefined;
  prompt: string;
  /** The effective access value: draft, then thread, then the configured default. */
  runtimeMode: RuntimeMode;
}

/** One model row, resolved against its exact instance's catalog. */
export interface CombinedPickerRowInput {
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
}

export interface CombinedPickerContext {
  planModeEnabled: boolean;
  /** False where no prompt can change, such as Settings. */
  allowPromptInjectedEffort: boolean;
}

/** A pending Ultrathink prefix change, applied to the prompt current at apply time. */
type PromptEffortIntent = "add" | "remove";

interface CombinedPickerRowEdit {
  modelOptions?: ProviderOptions | undefined;
  promptEffort?: PromptEffortIntent;
}

export interface CombinedPickerState {
  readonly saved: CombinedPickerSavedSelection;
  readonly rowEdits: ReadonlyMap<string, CombinedPickerRowEdit>;
  /** Access shown in the picker. Only written when `runtimeModeTouched`. */
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeTouched: boolean;
}

export interface CombinedPickerEffortOption {
  id: string;
  label: string;
  /** Visible but not selectable, such as Ultrathink where no prompt can change. */
  disabled: boolean;
}

export interface CombinedPickerEffort {
  descriptorId: string;
  value: string | null;
  label: string | null;
  options: ReadonlyArray<CombinedPickerEffortOption>;
  canDecrease: boolean;
  canIncrease: boolean;
  readOnlyReason: string | null;
}

export interface CombinedPickerRow {
  key: string;
  effort: CombinedPickerEffort | null;
  optionState: ProviderOptionState;
}

export interface CombinedPickerCandidate {
  modelSelection: ModelSelection;
  prompt: string;
  /** Present only when the access control was edited during this opening. */
  runtimeMode?: RuntimeMode;
  /**
   * Present when the prompt changed after the row's effort was staged and now
   * pins the effort, so the choice must not be applied.
   */
  blockedReason?: string;
}

const ULTRATHINK_PREFIX_PATTERN = /^\s*Ultrathink:\s*/i;

export function createCombinedPickerState(
  saved: CombinedPickerSavedSelection,
): CombinedPickerState {
  return {
    saved,
    rowEdits: new Map(),
    runtimeMode: saved.runtimeMode,
    runtimeModeTouched: false,
  };
}

function applyPromptEffort(prompt: string, intent: PromptEffortIntent | undefined): string {
  if (intent === "add") {
    return prompt.trim().length === 0
      ? ULTRATHINK_PROMPT_PREFIX
      : applyClaudePromptEffortPrefix(prompt, "ultrathink");
  }
  if (intent === "remove") {
    return prompt.replace(ULTRATHINK_PREFIX_PATTERN, "");
  }
  return prompt;
}

function hasUltrathinkPrefix(prompt: string): boolean {
  return ULTRATHINK_PREFIX_PATTERN.test(prompt);
}

function rowKey(row: CombinedPickerRowInput): string {
  return modelPickerModelKey(row.instanceId, row.model);
}

function rowSelections(state: CombinedPickerState, row: CombinedPickerRowInput) {
  const edit = state.rowEdits.get(rowKey(row));
  const savedOptions =
    edit && "modelOptions" in edit
      ? edit.modelOptions
      : state.saved.modelOptionsByInstance?.[row.instanceId];
  return { edit, savedOptions };
}

function resolveRowOptionState(
  state: CombinedPickerState,
  row: CombinedPickerRowInput,
  context: CombinedPickerContext,
) {
  const { edit, savedOptions } = rowSelections(state, row);
  // The same Normal/Fast default the composer dispatches with.
  const { selections } = resolveComposerOptionSelections(
    row.models,
    row.model,
    row.driverKind,
    savedOptions,
    context.planModeEnabled,
  );
  const prompt = applyPromptEffort(state.saved.prompt, edit?.promptEffort);
  const optionState = resolveProviderOptionState({
    provider: row.driverKind,
    models: row.models,
    model: row.model,
    prompt,
    modelOptions: selections,
    allowPromptInjectedEffort: context.allowPromptInjectedEffort,
    planModeEnabled: context.planModeEnabled,
  });
  return { optionState, prompt, selections };
}

function resolveEffort(optionState: ProviderOptionState): CombinedPickerEffort | null {
  const descriptor = optionState.effortDescriptor;
  if (!descriptor) return null;
  const readOnlyReason = getProviderOptionReadOnlyReason(optionState, descriptor.id);
  const options = descriptor.options.map((option) => ({
    id: option.id,
    label: option.label,
    disabled:
      !optionState.allowPromptInjectedEffort &&
      (descriptor.promptInjectedValues?.includes(option.id) ?? false),
  }));
  const value = optionState.effort;
  const enabled = options.filter((option) => !option.disabled);
  const index = enabled.findIndex((option) => option.id === value);
  return {
    descriptorId: descriptor.id,
    value,
    label: options.find((option) => option.id === value)?.label ?? value,
    options,
    canDecrease: readOnlyReason === null && index !== 0 && enabled.length > 0,
    canIncrease: readOnlyReason === null && index !== enabled.length - 1 && enabled.length > 0,
    readOnlyReason,
  };
}

export function resolveCombinedPickerRow(
  state: CombinedPickerState,
  row: CombinedPickerRowInput,
  context: CombinedPickerContext,
): CombinedPickerRow {
  const { optionState } = resolveRowOptionState(state, row, context);
  return { key: rowKey(row), effort: resolveEffort(optionState), optionState };
}

function applyRowChange(
  state: CombinedPickerState,
  row: CombinedPickerRowInput,
  context: CombinedPickerContext,
  descriptorId: string,
  value: string | boolean,
): CombinedPickerState {
  const { optionState, prompt } = resolveRowOptionState(state, row, context);
  const change = applyProviderOptionChange(optionState, { descriptorId, value, prompt });
  if (!change) return state;
  const key = rowKey(row);
  const previous = state.rowEdits.get(key);
  const next: CombinedPickerRowEdit = { ...previous };
  if (change.modelOptionsChanged) {
    next.modelOptions = change.modelOptions;
  }
  // Record the prefix as an intent relative to the saved prompt, so applying
  // it later never replaces text typed while the picker was open.
  const prefixed = hasUltrathinkPrefix(change.prompt);
  if (prefixed === hasUltrathinkPrefix(state.saved.prompt)) {
    delete next.promptEffort;
  } else {
    next.promptEffort = prefixed ? "add" : "remove";
  }
  const rowEdits = new Map(state.rowEdits);
  rowEdits.set(key, next);
  return { ...state, rowEdits };
}

/** Moves the row's effort one step in its provider's order, clamping at the ends. */
export function stepCombinedPickerEffort(
  state: CombinedPickerState,
  row: CombinedPickerRowInput,
  context: CombinedPickerContext,
  direction: 1 | -1,
): CombinedPickerState {
  const effort = resolveCombinedPickerRow(state, row, context).effort;
  if (!effort || effort.readOnlyReason !== null) return state;
  const enabled = effort.options.filter((option) => !option.disabled);
  const index = enabled.findIndex((option) => option.id === effort.value);
  const nextIndex = index < 0 ? 0 : Math.min(enabled.length - 1, Math.max(0, index + direction));
  const target = enabled[nextIndex];
  if (!target || target.id === effort.value) return state;
  return applyRowChange(state, row, context, effort.descriptorId, target.id);
}

/** Sets one extra provider option for a row without applying the row. */
export function setCombinedPickerOption(
  state: CombinedPickerState,
  row: CombinedPickerRowInput,
  context: CombinedPickerContext,
  descriptorId: string,
  value: string | boolean,
): CombinedPickerState {
  return applyRowChange(state, row, context, descriptorId, value);
}

export function setCombinedPickerRuntimeMode(
  state: CombinedPickerState,
  runtimeMode: RuntimeMode,
): CombinedPickerState {
  if (state.runtimeModeTouched && state.runtimeMode === runtimeMode) return state;
  return { ...state, runtimeMode, runtimeModeTouched: true };
}

/**
 * The complete selection for applying one row. Options are the row's full
 * explicit set, so callers replace stored options instead of merging them.
 * `currentPrompt` is read at apply time, keeping text typed while the picker
 * was open.
 */
export function buildCombinedPickerCandidate(
  state: CombinedPickerState,
  row: CombinedPickerRowInput,
  context: CombinedPickerContext,
  currentPrompt: string,
): CombinedPickerCandidate {
  const { optionState, selections } = resolveRowOptionState(state, row, context);
  const edit = state.rowEdits.get(rowKey(row));
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    optionState.descriptors,
    selections,
  );
  const blocked =
    stagesEffortChange(state, row, context, optionState) &&
    resolveProviderOptionState({
      provider: row.driverKind,
      models: row.models,
      model: row.model,
      prompt: currentPrompt,
      modelOptions: selections,
      allowPromptInjectedEffort: context.allowPromptInjectedEffort,
      planModeEnabled: context.planModeEnabled,
    }).ultrathinkInBodyText;
  return {
    modelSelection: createModelSelection(row.instanceId, row.model, options),
    prompt: applyPromptEffort(currentPrompt, edit?.promptEffort),
    ...(state.runtimeModeTouched ? { runtimeMode: state.runtimeMode } : {}),
    ...(blocked ? { blockedReason: ULTRATHINK_IN_BODY_REASON } : {}),
  };
}

/** Whether the row's pending edits change its prompt-controllable effort. */
function stagesEffortChange(
  state: CombinedPickerState,
  row: CombinedPickerRowInput,
  context: CombinedPickerContext,
  editedState: ProviderOptionState,
): boolean {
  const edit = state.rowEdits.get(rowKey(row));
  if (!edit) return false;
  if (edit.promptEffort !== undefined) return true;
  const descriptorId = editedState.promptEffortDescriptor?.id;
  if (!("modelOptions" in edit) || !descriptorId) return false;
  const { optionState: savedState } = resolveRowOptionState(
    { ...state, rowEdits: new Map() },
    row,
    context,
  );
  const valueOf = (optionState: ProviderOptionState) =>
    getProviderOptionCurrentValue(
      optionState.descriptors.find((descriptor) => descriptor.id === descriptorId),
    );
  return valueOf(savedState) !== valueOf(editedState);
}

/**
 * Opt-in configuration that turns the model picker into the combined picker.
 * Callers that omit it keep the model-only picker.
 */
export interface CombinedPickerConfig {
  /** Read once when the picker opens; the opening keeps that snapshot. */
  readSavedSelection: () => CombinedPickerSavedSelection;
  /** Read when a row is applied, so text typed meanwhile is kept. */
  readCurrentPrompt: () => string;
  context: CombinedPickerContext;
  onApply: (candidate: CombinedPickerCandidate) => void;
  /** Open with More options expanded and its first control focused. */
  initialExtrasExpanded?: boolean;
  /** Lets `traitsPicker.toggle` toggle More options while this picker is open. */
  respondsToShortcut?: boolean;
}
