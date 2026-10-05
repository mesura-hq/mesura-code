import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";
import { Kbd } from "../ui/kbd";
import { Switch } from "../ui/switch";
import {
  UNAVAILABLE_MODEL_OPTIONS_REASON,
  getProviderOptionReadOnlyReason,
  type ProviderOptionState,
} from "./providerOptionState";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";

/**
 * The combined picker's single "More options" disclosure. Collapsed, it is one
 * row with a small access summary. Expanded, it holds the highlighted model's
 * extra provider controls, the access level, and a button that applies the
 * pending choice. It sits outside the model list's keyboard handling, so Tab
 * moves through its controls normally.
 */

export interface CombinedPickerOptionsTarget {
  modelName: string;
  providerName: string;
  optionState: ProviderOptionState;
  /** Descriptors the picker's context refuses to save; shown disabled with the reason. */
  optionReadOnlyReasons?: Readonly<Record<string, string>>;
}

const PROMPT_INJECTED_EFFORT_REASON = "needs a chat prompt, so it cannot be chosen here.";

const APPLY_BUTTON_CLASS_NAME =
  "mt-1.5 flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64";

const NATIVE_SELECT_CLASS_NAME =
  "h-6 min-w-0 max-w-40 shrink rounded-md border border-input bg-background px-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64";

function OptionRow(props: { label: string; note?: string | null; children: ReactNode }) {
  return (
    <div className="py-0.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{props.label}</span>
        {props.children}
      </div>
      {props.note ? (
        <p className="pb-0.5 text-[11px] leading-4 text-muted-foreground/70">{props.note}</p>
      ) : null}
    </div>
  );
}

function DescriptorControl(props: {
  descriptor: ProviderOptionDescriptor;
  optionState: ProviderOptionState;
  contextReadOnlyReason: string | null;
  onChange: (descriptorId: string, value: string | boolean) => void;
}) {
  const { descriptor, optionState, contextReadOnlyReason } = props;
  const readOnlyReason =
    getProviderOptionReadOnlyReason(optionState, descriptor.id) ?? contextReadOnlyReason;
  if (optionState.modelIsUnavailable) {
    return (
      <OptionRow label={descriptor.label}>
        <span className="truncate text-xs text-muted-foreground/80">
          {getProviderOptionCurrentLabel(descriptor) ?? ""}
        </span>
      </OptionRow>
    );
  }
  if (descriptor.type === "boolean") {
    return (
      <OptionRow label={descriptor.label} note={contextReadOnlyReason}>
        <Switch
          size="sm"
          aria-label={descriptor.label}
          checked={descriptor.currentValue === true}
          disabled={readOnlyReason !== null}
          onCheckedChange={(checked) => props.onChange(descriptor.id, checked)}
        />
      </OptionRow>
    );
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  const value =
    optionState.ultrathinkPromptControlled &&
    descriptor.id === optionState.promptEffortDescriptor?.id
      ? "ultrathink"
      : typeof currentValue === "string"
        ? currentValue
        : "";
  return (
    <OptionRow label={descriptor.label} note={contextReadOnlyReason}>
      <select
        aria-label={descriptor.label}
        className={NATIVE_SELECT_CLASS_NAME}
        value={value}
        disabled={readOnlyReason !== null}
        onChange={(event) => props.onChange(descriptor.id, event.target.value)}
      >
        {value === "" ? <option value="">Choose…</option> : null}
        {descriptor.options.map((option) => (
          <option
            key={option.id}
            value={option.id}
            disabled={
              !optionState.allowPromptInjectedEffort &&
              (descriptor.promptInjectedValues?.includes(option.id) ?? false)
            }
          >
            {option.label}
          </option>
        ))}
      </select>
    </OptionRow>
  );
}

export function CombinedPickerOptions(props: {
  expanded: boolean;
  regionId: string;
  regionRef: Ref<HTMLDivElement>;
  toggleRef: Ref<HTMLButtonElement>;
  shortcutLabel: string | null;
  runtimeMode: RuntimeMode;
  /** Targets disagree and access was not edited in this opening. */
  runtimeModeMixed?: boolean;
  /** Replaces the access control where the context has no access setting. */
  accessReadOnlyLabel?: string | null;
  target: CombinedPickerOptionsTarget | null;
  onToggle: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onOptionChange: (descriptorId: string, value: string | boolean) => void;
  onUse: () => void;
  /**
   * Applies only the access edit when no model is targeted. Absent where the
   * picker offers no access-only apply; null while access is unedited.
   */
  onApplyAccess?: (() => void) | null;
}) {
  const access = runtimeModeConfig[props.runtimeMode];
  const AccessIcon = access.icon;
  const accessSummary =
    props.accessReadOnlyLabel ?? (props.runtimeModeMixed ? "Mixed" : access.label);
  const target = props.target;
  const effortDescriptorId = target?.optionState.effortDescriptor?.id;
  const effortReadOnlyReason =
    target && effortDescriptorId
      ? getProviderOptionReadOnlyReason(target.optionState, effortDescriptorId)
      : null;
  const extraDescriptors = target?.optionState.extraDescriptors ?? [];
  // Prompt-injected effort values (Claude Ultrathink) stay visible where no
  // prompt can change, with the reason they cannot be chosen.
  const effortDescriptor = target?.optionState.effortDescriptor ?? null;
  const promptInjectedEffortLabels =
    target && effortDescriptor && !target.optionState.allowPromptInjectedEffort
      ? effortDescriptor.options
          .filter((option) => effortDescriptor.promptInjectedValues?.includes(option.id))
          .map((option) => option.label)
      : [];
  return (
    <section
      aria-label="Additional model options"
      className="flex min-h-0 flex-1 flex-col border-t border-border/70 bg-muted/40"
    >
      <button
        ref={props.toggleRef}
        type="button"
        aria-expanded={props.expanded}
        aria-controls={props.regionId}
        onClick={props.onToggle}
        className="flex h-8 w-full shrink-0 items-center gap-2 px-3 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:bg-foreground/5 focus-visible:text-foreground"
      >
        <span className="shrink-0 font-medium">More options</span>
        {props.shortcutLabel ? (
          <Kbd className="h-4 min-w-0 rounded-sm px-1 text-[10px]">{props.shortcutLabel}</Kbd>
        ) : null}
        <span className="ml-auto flex min-w-0 items-center gap-1 text-muted-foreground/80">
          {props.accessReadOnlyLabel || props.runtimeModeMixed ? null : (
            <AccessIcon aria-hidden="true" className="size-3 shrink-0" />
          )}
          <span className="truncate">{accessSummary}</span>
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", props.expanded && "rotate-180")}
        />
      </button>
      {props.expanded ? (
        <div
          ref={props.regionRef}
          id={props.regionId}
          className="max-h-48 min-h-0 flex-1 overflow-y-auto border-t border-border/50 px-3 pt-1.5 pb-2"
        >
          <div className="truncate pb-1 text-[11px] font-medium text-foreground">
            {target ? `${target.modelName} · ${target.providerName}` : "No model highlighted"}
          </div>
          {effortReadOnlyReason ? (
            <p className="pb-1 text-xs text-muted-foreground/80">{effortReadOnlyReason}</p>
          ) : target?.optionState.modelIsUnavailable ? (
            <p className="pb-1 text-xs text-muted-foreground/80">
              {UNAVAILABLE_MODEL_OPTIONS_REASON}
            </p>
          ) : null}
          {promptInjectedEffortLabels.length > 0 ? (
            <p className="pb-1 text-xs text-muted-foreground/80">
              {`${promptInjectedEffortLabels.join(", ")} ${PROMPT_INJECTED_EFFORT_REASON}`}
            </p>
          ) : null}
          {target && extraDescriptors.length > 0 ? (
            extraDescriptors.map((descriptor) => (
              <DescriptorControl
                key={descriptor.id}
                descriptor={descriptor}
                optionState={target.optionState}
                contextReadOnlyReason={target.optionReadOnlyReasons?.[descriptor.id] ?? null}
                onChange={props.onOptionChange}
              />
            ))
          ) : (
            <p className="py-1 text-xs text-muted-foreground/70">
              {target
                ? "This model has no additional controls."
                : "Highlight a model to see its options."}
            </p>
          )}
          <OptionRow label="Access">
            {props.accessReadOnlyLabel ? (
              <span className="truncate text-xs text-muted-foreground/80">
                {props.accessReadOnlyLabel}
              </span>
            ) : (
              <select
                aria-label="Access level"
                className={NATIVE_SELECT_CLASS_NAME}
                value={props.runtimeModeMixed ? "" : props.runtimeMode}
                onChange={(event) => {
                  const next = runtimeModeOptions.find((mode) => mode === event.target.value);
                  if (next) props.onRuntimeModeChange(next);
                }}
              >
                {props.runtimeModeMixed ? (
                  <option value="" disabled>
                    Mixed
                  </option>
                ) : null}
                {runtimeModeOptions.map((mode) => (
                  <option key={mode} value={mode}>
                    {runtimeModeConfig[mode].label}
                  </option>
                ))}
              </select>
            )}
          </OptionRow>
          {!target && props.onApplyAccess !== undefined ? (
            <button
              type="button"
              disabled={props.onApplyAccess === null}
              onClick={() => props.onApplyAccess?.()}
              className={APPLY_BUTTON_CLASS_NAME}
            >
              <span className="truncate">Apply access</span>
              <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
            </button>
          ) : null}
          {target ? (
            <button type="button" onClick={props.onUse} className={APPLY_BUTTON_CLASS_NAME}>
              <span className="truncate">Use {target.modelName}</span>
              <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
