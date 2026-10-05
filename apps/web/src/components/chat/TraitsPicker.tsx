import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { memo, useCallback, useEffect } from "react";
import type { VariantProps } from "class-variance-authority";
import { ZapIcon } from "lucide-react";
import { buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import {
  applyProviderOptionChange,
  buildUnavailableModelOptionDescriptors,
  resolveComposerOptionSelections,
  resolveProviderOptionState,
} from "./providerOptionState";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { subscribePickerAction } from "../../lib/pickerActionBus";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

export { buildUnavailableModelOptionDescriptors };

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function DefaultBadge() {
  return (
    <Badge
      variant="outline"
      className="inline-flex h-4 w-fit min-w-0 items-center justify-center gap-0 border-border/70 bg-muted/60 px-1.5 py-0 font-semibold text-[10px] text-muted-foreground leading-none sm:h-4"
    >
      Default
    </Badge>
  );
}

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
): string | null {
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}): boolean {
  return resolveProviderOptionState(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  isComposerOwned?: boolean;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, persistence, provider, setProviderModelOptions],
  );
  const optionState = resolveProviderOptionState({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  });
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    promptEffortDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
    modelIsUnavailable,
  } = optionState;
  const handleChange = (descriptorId: string, value: string | boolean) => {
    const change = applyProviderOptionChange(optionState, { descriptorId, value, prompt });
    if (!change) return;
    if (change.prompt !== prompt) {
      onPromptChange(change.prompt);
    }
    if (change.modelOptionsChanged) {
      updateModelOptions(change.modelOptions);
    }
  };

  if (!hasAnyControls) {
    return null;
  }

  if (modelIsUnavailable) {
    return (
      <>
        {descriptors.map((descriptor, index) => {
          const value = getProviderOptionCurrentLabel(descriptor);
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuDivider /> : null}
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  {descriptor.label}
                </div>
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
              </MenuGroup>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => {
        const selectedValue =
          ultrathinkPromptControlled && descriptor.id === promptEffortDescriptor?.id
            ? "ultrathink"
            : (getDescriptorStringValue(descriptor) ?? "");

        return (
          <div key={descriptor.id}>
            {index > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              {ultrathinkInBodyText && descriptor.id === promptEffortDescriptor?.id ? (
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                  Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                  option.
                </div>
              ) : null}
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => handleChange(descriptor.id, value)}
              >
                {descriptor.options.map((option) => (
                  <MenuRadioItem
                    key={option.id}
                    value={option.id}
                    hideIndicator
                    // Base UI keeps radio menus open by default. Close on pick so
                    // the traits menu behaves like the model picker.
                    closeOnClick
                    disabled={ultrathinkInBodyText && descriptor.id === promptEffortDescriptor?.id}
                  >
                    <span className="flex w-full min-w-0 flex-col">
                      <span className="flex w-full min-w-0 items-center justify-between gap-3">
                        <span className="min-w-0 truncate">
                          {option.label}
                          {option.isDefault ? (
                            <>
                              {" "}
                              <DefaultBadge />
                            </>
                          ) : null}
                        </span>
                      </span>
                      {option.description ? (
                        <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
      {booleanDescriptors.map((descriptor, index) => {
        const selectedValue = descriptor.currentValue === true ? "on" : "off";

        return (
          <div key={descriptor.id}>
            {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => handleChange(descriptor.id, value === "on")}
              >
                {(["on", "off"] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span>{value === "on" ? "On" : "Off"}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
    </>
  );
});

/**
 * Build the traits trigger's text label plus whether the fast-mode bolt should
 * render. Claude and Cursor expose fast mode as a boolean, while Codex exposes
 * it through the Standard/Fast service tiers. In either form, fast mode is a
 * lightning bolt when on and nothing at all when off. The one exception is when
 * fast mode is the only trait, where a bare bolt (or bare chevron) would leave
 * the trigger unreadable.
 */
export function buildTraitsTriggerDisplay(input: {
  provider: ProviderDriverKind;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
}): { label: string; showFastModeIcon: boolean } {
  let fastModeFallbackLabel: string | null = null;
  let fastModeEnabled = false;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      fastModeEnabled = descriptor.currentValue === true;
      fastModeFallbackLabel = fastModeEnabled ? "Fast" : "Normal";
      continue;
    }
    if (
      input.provider === "codex" &&
      descriptor.id === "serviceTier" &&
      descriptor.type === "select"
    ) {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      if (fastTier && (currentValue === "default" || currentValue === fastTier.id)) {
        fastModeEnabled = currentValue === fastTier.id;
        fastModeFallbackLabel =
          descriptor.options.find(({ id }) => id === currentValue)?.label ??
          (fastModeEnabled ? "Fast" : "Normal");
        continue;
      }
    }
    const label =
      input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
          : getProviderOptionCurrentLabel(descriptor);
    if (typeof label === "string" && label.length > 0) {
      labels.push(label);
    }
  }

  // Only fall back to text when fast mode is genuinely the sole trait. Keying
  // off an empty label list alone would also catch descriptors that resolved to
  // no label at all, printing a bogus "Normal" for a model without fast mode.
  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel, showFastModeIcon: false };
  }
  return { label: labels.join(" · "), showFastModeIcon: fastModeEnabled };
}

/**
 * The trigger traits for a saved selection, with the composer's Normal/Fast
 * default applied, or undefined when the model has no controls.
 */
export function resolveTraitsTriggerDisplay(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string;
  prompt: string;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  planModeEnabled: boolean;
}): { label: string; showFastModeIcon: boolean } | undefined {
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
  return optionState.hasAnyControls
    ? buildTraitsTriggerDisplay({
        provider: input.provider,
        descriptors: optionState.descriptors,
        primarySelectDescriptorId: optionState.promptEffortDescriptor?.id ?? null,
        ultrathinkPromptControlled: optionState.ultrathinkPromptControlled,
      })
    : undefined;
}

export interface TraitsPickerProps extends TraitsMenuContentProps {
  /**
   * Opt this picker into the `traitsPicker.toggle` keybinding. Only the
   * composer sets it: the same component renders inside settings panels, and
   * those must not open from a chat shortcut.
   */
  respondsToShortcut?: boolean;
}

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  triggerVariant,
  triggerClassName,
  isComposerOwned,
  size = "sm",
  hidden = false,
  respondsToShortcut = false,
  ...persistence
}: TraitsPickerProps &
  TraitsPersistence & {
    size?: ComposerControlSize;
    hidden?: boolean;
  }) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden);
  const traitsVisibilityInput = {
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  };
  const { descriptors, promptEffortDescriptor, ultrathinkPromptControlled } =
    resolveProviderOptionState(traitsVisibilityInput);
  const canRenderTraits = shouldRenderTraitsControls(traitsVisibilityInput);
  // Hooks must run before the early return below, so the subscription is gated
  // on the same visibility check rather than sitting above it. Without the
  // gate a press while the provider exposes no traits still flips the state,
  // and the menu then opens on its own the moment the user selects a provider
  // that does. Closing on the way out keeps that state from surviving either.
  useEffect(() => {
    if (!respondsToShortcut || !canRenderTraits) {
      setIsMenuOpen(false);
      return;
    }
    return subscribePickerAction("traits", () => {
      setIsMenuOpen((open) => !open);
    });
  }, [respondsToShortcut, canRenderTraits]);
  if (!canRenderTraits) {
    return null;
  }

  const { label: triggerLabel, showFastModeIcon } = buildTraitsTriggerDisplay({
    provider,
    descriptors,
    primarySelectDescriptorId: promptEffortDescriptor?.id ?? null,
    ultrathinkPromptControlled,
  });
  const fastModeIcon = showFastModeIcon ? (
    <>
      <ComposerControlIcon
        icon={ZapIcon}
        size={size}
        className={cn(
          "fill-current opacity-80",
          size === "xs"
            ? "text-current"
            : provider === "claudeAgent"
              ? "text-[#d97757]"
              : "text-foreground",
        )}
      />
      <span className="sr-only">Fast mode on</span>
    </>
  ) : null;

  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <ComposerControl
            data-composer-shortcut={isComposerOwned ? "composer.effort" : undefined}
            variant={triggerVariant ?? "ghost"}
            size={size}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                : "shrink-0 whitespace-nowrap",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          // The label truncates itself; clipping the wrapper too would cut off
          // the chevron, whose negative end margin overhangs the wrapper edge.
          <span
            className={cn("flex min-w-0 w-full items-center", size === "xs" ? "gap-1" : "gap-1.5")}
          >
            {fastModeIcon}
            <span className="min-w-0 truncate">{triggerLabel}</span>
            <ComposerControlChevron size={size} />
          </span>
        ) : (
          <>
            {fastModeIcon}
            <span>{triggerLabel}</span>
            <ComposerControlChevron size={size} />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start" {...(isComposerOwned ? composerFloatingLayerProps : {})}>
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          planModeEnabled={planModeEnabled}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
