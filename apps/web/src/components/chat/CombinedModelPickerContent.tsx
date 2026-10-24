import type { ProviderInstanceId, RuntimeMode, ServerProviderModel } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type SyntheticEvent,
} from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { subscribePickerAction } from "../../lib/pickerActionBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CombinedPickerOptions } from "./CombinedPickerOptions";
import {
  buildCombinedPickerCandidate,
  createCombinedPickerState,
  resolveCombinedPickerRow,
  setCombinedPickerOption,
  setCombinedPickerRuntimeMode,
  stepCombinedPickerEffort,
  type CombinedPickerConfig,
  type CombinedPickerEffort,
  type CombinedPickerRowInput,
} from "./combinedPickerState";
import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import type { ModelPickerExtension } from "./modelPickerExtension";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";
import { getDisplayModelName } from "./providerIconUtils";
import { runtimeModeOptions } from "./runtimeModeConfig";

/**
 * The combined model, effort, options, and access picker. It wraps upstream's
 * `ModelPickerContent` through `ModelPickerExtension` and adds:
 *
 * - an inline effort stepper on every model row, also driven by Left/Right;
 * - Tab and Shift+Tab to cycle provider tabs from the search field;
 * - the More options screen, which replaces model search inside the same
 *   bounded popup and holds the other provider options and the access mode.
 *
 * Every edit stays pending in this component until a row is applied, so
 * Escape or a click outside (which unmount it) discards them.
 */

type ModelPickerContentProps = ComponentProps<typeof ModelPickerContent>;

type CombinedModelPickerContentProps = ModelPickerContentProps & {
  combined?: CombinedPickerConfig | undefined;
  /** The trigger's viewport rect, so the picker can fit beside it. */
  getAnchorRect?: (() => DOMRect | null) | undefined;
  /** While true, applying a row does nothing, as for the model-only picker. */
  disabled?: boolean | undefined;
};

/** Upstream's model-only picker unless `combined` opts into the combined picker. */
export const CombinedModelPickerContent = memo(function CombinedModelPickerContent(
  props: CombinedModelPickerContentProps,
) {
  const { combined, getAnchorRect, disabled, ...contentProps } = props;
  if (!combined) return <ModelPickerContent {...contentProps} />;
  return (
    <CombinedPicker
      {...contentProps}
      combined={combined}
      getAnchorRect={getAnchorRect}
      disabled={disabled === true}
    />
  );
});

// WORKAROUND: the combined picker sizes itself from its trigger's position
// instead of Base UI's `--available-height`. Base UI's popup measurement
// (usePopupAutoResize) temporarily sets that variable to `max-content`, so a
// cap built on it measures at full height and opens off-screen on short
// viewports. The margin mirrors Base UI internals: the 4px side offset, the
// flip padding (5px plus two 1px side biases), the popup's 1px borders, and
// 2px for subpixel rounding; with less, Base UI flips the popup to the side.
// Remove this, and `resolveModelPickerFitHeight`, once Base UI offers a
// supported way to cap popup content by the available height during
// measurement; re-check the margin on every Base UI upgrade until then.
const MODEL_PICKER_VIEWPORT_MARGIN_PX = 16;
const EMPTY_CATALOG: ReadonlyArray<ServerProviderModel> = [];

/**
 * The tallest the combined picker can be while it still opens beside its
 * trigger: the room on the larger side of the trigger, less the popup margin.
 */
export function resolveModelPickerFitHeight(input: {
  anchorTop: number;
  anchorBottom: number;
  viewportHeight: number;
}): number {
  const space = Math.max(input.anchorTop, input.viewportHeight - input.anchorBottom);
  return Math.max(0, Math.floor(space - MODEL_PICKER_VIEWPORT_MARGIN_PX));
}

// The More options bar is 2rem tall; the model screen takes the rest.
const PICKER_HEIGHT_CLASS_NAME = "max-h-[min(21.625rem,var(--model-picker-fit-height,21.625rem))]";
const MODEL_SCREEN_HEIGHT_CLASS_NAME =
  "max-h-[calc(min(21.625rem,var(--model-picker-fit-height,21.625rem))-2rem)]";

function CombinedPicker(
  props: ModelPickerContentProps & {
    combined: CombinedPickerConfig;
    getAnchorRect: (() => DOMRect | null) | undefined;
    disabled: boolean;
  },
) {
  const { combined, getAnchorRect, disabled, ...contentProps } = props;
  const {
    instanceEntries,
    modelOptionsByInstance,
    getModelDisabledReason,
    onRequestClose,
    onInstanceModelChange,
  } = contentProps;
  const { context } = combined;
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === contentProps.activeInstanceId,
  );
  // The saved row's key, as the model list names it.
  const savedSlug =
    resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model: contentProps.model,
      options: modelOptionsByInstance.get(contentProps.activeInstanceId) ?? [],
    })?.slug ?? contentProps.model;
  const savedRowKey = modelPickerModelKey(contentProps.activeInstanceId, savedSlug);

  // The pending edits of this opening. Dismissal unmounts this component,
  // which discards them.
  const [pickerState, setPickerState] = useState(() => {
    const saved = combined.readSavedSelection();
    return createCombinedPickerState(
      saved.instanceId === contentProps.activeInstanceId ? { ...saved, model: savedSlug } : saved,
    );
  });
  const [extrasExpanded, setExtrasExpanded] = useState(combined.initialExtrasExpanded === true);
  const extrasExpandedRef = useRef(extrasExpanded);
  // More options targets the model highlighted last before it opened. Hover
  // only updates this ref, so it does not re-render the model list.
  const lastHighlightedModelKeyRef = useRef<string | null>(null);
  const [extrasTargetKey, setExtrasTargetKey] = useState<string | null>(null);
  // Which rows the model screen shows, as it last reported them.
  const [isModelVisible, setIsModelVisible] = useState<(modelKey: string) => boolean>(
    () => () => true,
  );
  // ModelPickerContent reports visibility from an effect; a new callback
  // identity would make that effect update parent state after every render.
  const reportVisibleModels = useStableCallback((isVisible: (modelKey: string) => boolean) =>
    setIsModelVisible(() => isVisible),
  );
  const [effortAnnouncement, setEffortAnnouncement] = useState("");
  const extrasRegionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const extrasRegionRef = useRef<HTMLDivElement>(null);
  const extrasToggleRef = useRef<HTMLButtonElement>(null);
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = contentProps.keybindings ?? serverKeybindings;

  // The React compiler memoizes these per catalog update.
  const entryByInstanceId = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));
  // Each row resolves its options against a one-entry catalog, so pending
  // effort edits never scan an instance's whole catalog per mounted row.
  const catalogEntryByModelKey = new Map<string, ReadonlyArray<ServerProviderModel>>();
  for (const entry of instanceEntries) {
    for (const model of entry.models) {
      catalogEntryByModelKey.set(modelPickerModelKey(entry.instanceId, model.slug), [model]);
    }
  }
  const rowInput = (
    instanceId: ProviderInstanceId,
    slug: string,
  ): CombinedPickerRowInput | null => {
    const entry = entryByInstanceId.get(instanceId);
    return entry
      ? {
          instanceId,
          driverKind: entry.driverKind,
          model: slug,
          models:
            catalogEntryByModelKey.get(modelPickerModelKey(instanceId, slug)) ?? EMPTY_CATALOG,
        }
      : null;
  };
  const preferShortName = contentProps.lockedProvider === null;
  const modelName = (instanceId: ProviderInstanceId, slug: string) => {
    const model = modelOptionsByInstance
      .get(instanceId)
      ?.find((candidate) => candidate.slug === slug);
    if (!model) return slug;
    return getDisplayModelName(model, preferShortName ? { preferShortName: true } : undefined);
  };

  const applyRow = (row: CombinedPickerRowInput, appliedFrom: "row" | "use") => {
    if (disabled) return;
    const candidate = buildCombinedPickerCandidate(
      pickerState,
      row,
      context,
      combined.readCurrentPrompt(),
      appliedFrom,
    );
    // A disabled row can only carry an access edit through Use; the caller
    // validates it. Every other choice of a disabled model stays refused.
    if (getModelDisabledReason?.(row.instanceId, row.model) && candidate.selectionEdited) return;
    combined.onApply(candidate);
    onRequestClose?.();
  };

  const stepEffort = (instanceId: ProviderInstanceId, slug: string, direction: 1 | -1) => {
    if (getModelDisabledReason?.(instanceId, slug)) return;
    const row = rowInput(instanceId, slug);
    if (!row) return;
    const next = stepCombinedPickerEffort(pickerState, row, context, direction);
    if (next === pickerState) return;
    setPickerState(next);
    const effort = resolveCombinedPickerRow(next, row, context).effort;
    setEffortAnnouncement(`${modelName(instanceId, slug)} effort ${effort?.label ?? ""}`);
  };

  const rememberHighlightedModel = (modelKey: string) => {
    if (extrasExpandedRef.current) return;
    const model = parseModelPickerModelKey(modelKey);
    if (!model || getModelDisabledReason?.(model.instanceId, model.slug)) return;
    lastHighlightedModelKeyRef.current = modelKey;
  };

  const focusSearch = () => {
    rootRef.current
      ?.querySelector<HTMLInputElement>('[data-slot="combobox-input"]')
      ?.focus({ preventScroll: true });
  };
  // The first control in More options, or its toggle when it has none.
  const focusExtras = () => {
    const target =
      extrasRegionRef.current?.querySelector<HTMLElement>(
        "select:not(:disabled), button:not(:disabled), input:not(:disabled), [role='switch']",
      ) ?? extrasToggleRef.current;
    target?.focus({ preventScroll: true });
  };

  // Opening on More options focuses its first control. The model content
  // keeps retrying its search focus for a frame, but its search is hidden.
  const opensOnExtras = combined.initialExtrasExpanded === true;
  useLayoutEffect(() => {
    if (!opensOnExtras) return;
    focusExtras();
    const frame = window.requestAnimationFrame(focusExtras);
    const timeout = window.setTimeout(focusExtras, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusExtras, opensOnExtras]);

  // WORKAROUND (see MODEL_PICKER_VIEWPORT_MARGIN_PX): size the picker to the
  // larger side of its trigger. This layout effect runs before Base UI's
  // measurement, because the popup is an ancestor of this content.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !getAnchorRect) return;
    const fitToViewport = () => {
      const anchor = getAnchorRect();
      if (!anchor) return;
      const fitHeight = resolveModelPickerFitHeight({
        anchorTop: anchor.top,
        anchorBottom: anchor.bottom,
        viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      });
      root.style.setProperty("--model-picker-fit-height", `${fitHeight}px`);
    };
    fitToViewport();
    window.addEventListener("resize", fitToViewport);
    return () => window.removeEventListener("resize", fitToViewport);
  }, [getAnchorRect]);

  // More options: the traits shortcut and the toggle open or close it, then
  // move focus into it or back to search after the render that shows it.
  const pendingExtrasFocusRef = useRef<"extras" | "search" | null>(null);
  const setExtras = (expanded: boolean) => {
    extrasExpandedRef.current = expanded;
    setExtrasExpanded(expanded);
    if (expanded) setExtrasTargetKey(lastHighlightedModelKeyRef.current);
    pendingExtrasFocusRef.current = expanded ? "extras" : "search";
  };
  useLayoutEffect(() => {
    const target = pendingExtrasFocusRef.current;
    if (target === null) return;
    pendingExtrasFocusRef.current = null;
    if (target === "extras") focusExtras();
    else focusSearch();
  });
  useEffect(() => {
    if (!combined.respondsToShortcut) return;
    return subscribePickerAction("traits", () => setExtras(!extrasExpandedRef.current));
  }, [combined.respondsToShortcut, setExtras]);
  // The traits shortcut (and its composer.effort alias) toggles More options
  // while the picker is open, including where no ChatView dispatches it, such
  // as Settings. In the composer ChatView may see the event first and
  // dispatch the picker action instead; this handler skips an event already
  // handled, so the section toggles once.
  const terminalOpen = contentProps.terminalOpen;
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { terminalFocus: false, terminalOpen, modelPickerOpen: true },
      });
      if (command !== "traitsPicker.toggle" && command !== "composer.effort") return;
      event.preventDefault();
      event.stopPropagation();
      setExtras(!extrasExpandedRef.current);
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [keybindings, setExtras, terminalOpen]);

  const resolveRowEffort = (instanceId: ProviderInstanceId, slug: string) => {
    const row = rowInput(instanceId, slug);
    return row ? resolveCombinedPickerRow(pickerState, row, context).effort : null;
  };

  const extension: ModelPickerExtension = {
    hidden: extrasExpanded,
    rootClassName: MODEL_SCREEN_HEIGHT_CLASS_NAME,
    rowRenderKey: pickerState,
    renderRowAccessory: ({ instanceId, slug, disabled: rowDisabled }) => {
      const effort = resolveRowEffort(instanceId, slug);
      return effort ? (
        <CombinedPickerRowEffort
          effort={effort}
          modelName={modelName(instanceId, slug)}
          disabled={rowDisabled}
          onStep={(direction) => {
            rememberHighlightedModel(modelPickerModelKey(instanceId, slug));
            stepEffort(instanceId, slug, direction);
          }}
        />
      ) : null;
    },
    onVisibleModelsChange: reportVisibleModels,
    onHighlightedModelChange: (modelKey, reason) => {
      // Base UI can restore the saved selection when focus leaves a row
      // control. That reset must not replace the user's target.
      const last = lastHighlightedModelKeyRef.current;
      if (modelKey !== null && (reason !== "none" || !last || !isModelVisible(last))) {
        rememberHighlightedModel(modelKey);
      }
    },
    onSearchKeyDown: (event, { highlightedModelKey, selectAdjacentProvider }) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
        return false;
      }
      // Tab cycles providers, including Favorites, instead of moving focus.
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        selectAdjacentProvider(event.shiftKey ? -1 : 1);
        return true;
      }
      // Plain Left/Right change the highlighted row's effort instead of
      // moving the caret.
      const highlighted =
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !event.shiftKey &&
        highlightedModelKey
          ? parseModelPickerModelKey(highlightedModelKey)
          : null;
      if (!highlighted) return false;
      event.preventDefault();
      event.stopPropagation();
      stepEffort(highlighted.instanceId, highlighted.slug, event.key === "ArrowRight" ? 1 : -1);
      return true;
    },
  };

  // More options edits the target row: the last highlighted model, else the
  // saved one, and only while the current tab and search show it. A model
  // the user cannot see is never edited or applied in its place.
  const extrasTarget = (() => {
    if (!extrasExpanded) return null;
    const targetKey = extrasTargetKey ?? savedRowKey;
    if (!isModelVisible(targetKey)) return null;
    const parsed = parseModelPickerModelKey(targetKey);
    const row = parsed ? rowInput(parsed.instanceId, parsed.slug) : null;
    const entry = parsed ? entryByInstanceId.get(parsed.instanceId) : undefined;
    if (!row || !entry) return null;
    return {
      row,
      entry,
      modelName: modelName(row.instanceId, row.model),
      providerName: entry.displayName,
      ...resolveCombinedPickerRow(pickerState, row, context),
    };
  })();
  // Access offers the modes the target's provider supports (the saved
  // provider's while More options is closed). A saved mode that provider
  // does not offer shows as its first supported mode, as the composer does.
  const accessEntry = extrasTarget?.entry ?? activeEntry;
  const supportedRuntimeModes = accessEntry?.snapshot.supportedRuntimeModes;
  const accessModes =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedRuntimeModes.includes(mode))
      : runtimeModeOptions;
  const shownRuntimeMode: RuntimeMode = accessModes.includes(pickerState.runtimeMode)
    ? pickerState.runtimeMode
    : (accessModes[0] ?? pickerState.runtimeMode);
  const extrasShortcutLabel = shortcutLabelForCommand(keybindings, "traitsPicker.toggle");

  return (
    <div
      ref={rootRef}
      className={`flex w-screen max-w-90 flex-col overflow-hidden ${PICKER_HEIGHT_CLASS_NAME}`}
      data-model-picker-content="true"
      data-combined-model-picker="true"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onRequestClose?.();
      }}
    >
      <ModelPickerContent
        {...contentProps}
        extension={extension}
        onInstanceModelChange={(instanceId, model) => {
          const row = rowInput(instanceId, model);
          // A row without an exact instance entry keeps the model-only change.
          if (row) applyRow(row, "row");
          else onInstanceModelChange(instanceId, model);
        }}
      />
      <CombinedPickerOptions
        expanded={extrasExpanded}
        regionId={extrasRegionId}
        regionRef={extrasRegionRef}
        toggleRef={extrasToggleRef}
        shortcutLabel={extrasShortcutLabel}
        runtimeMode={shownRuntimeMode}
        runtimeModeOptions={accessModes}
        runtimeModeMixed={
          pickerState.saved.runtimeModeMixed === true && !pickerState.runtimeModeTouched
        }
        accessReadOnlyLabel={context.accessReadOnlyLabel ?? null}
        {...(combined.onApplyAccess && !context.accessReadOnlyLabel
          ? {
              onApplyAccess: pickerState.runtimeModeTouched
                ? () => {
                    combined.onApplyAccess?.(pickerState.runtimeMode);
                    onRequestClose?.();
                  }
                : null,
            }
          : {})}
        target={extrasTarget}
        onToggle={() => setExtras(!extrasExpanded)}
        onRuntimeModeChange={(mode) =>
          setPickerState((current) => setCombinedPickerRuntimeMode(current, mode))
        }
        onOptionChange={(descriptorId, value) => {
          if (!extrasTarget) return;
          setPickerState((current) =>
            setCombinedPickerOption(current, extrasTarget.row, context, descriptorId, value),
          );
        }}
        onUse={() => {
          if (extrasTarget) applyRow(extrasTarget.row, "use");
        }}
      />
      <span aria-live="polite" className="sr-only">
        {effortAnnouncement}
      </span>
    </div>
  );
}

/** Keeps a stepper press from selecting the row or moving focus out of search. */
function stopRowSelection(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

const EFFORT_STEPPER_CLASS_NAME =
  "flex size-4 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-30";

/** A model row's inline effort: the value between decrease and increase steppers. */
function CombinedPickerRowEffort(props: {
  effort: CombinedPickerEffort;
  modelName: string;
  disabled: boolean;
  onStep: (direction: 1 | -1) => void;
}) {
  const { effort } = props;
  const value = (
    <span
      data-combined-picker-effort-value
      className="min-w-10 truncate text-center text-2xs leading-none text-muted-foreground"
    >
      {effort.label ?? "Default"}
    </span>
  );
  if (effort.readOnlyReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger render={<div className="flex max-w-24 shrink-0 items-center" />}>
          {value}
        </TooltipTrigger>
        <TooltipPopup side="top">{effort.readOnlyReason}</TooltipPopup>
      </Tooltip>
    );
  }
  const stepper = (direction: 1 | -1) => (
    <button
      type="button"
      tabIndex={-1}
      className={EFFORT_STEPPER_CLASS_NAME}
      aria-label={`${direction === 1 ? "Increase" : "Decrease"} effort for ${props.modelName}`}
      disabled={props.disabled || (direction === 1 ? !effort.canIncrease : !effort.canDecrease)}
      onPointerDown={stopRowSelection}
      onMouseDown={stopRowSelection}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        stopRowSelection(event);
        props.onStep(direction);
      }}
    >
      {direction === 1 ? (
        <ChevronRightIcon className="size-3" />
      ) : (
        <ChevronLeftIcon className="size-3" />
      )}
    </button>
  );
  return (
    <div className="flex max-w-28 shrink-0 items-center gap-0.5">
      {stepper(-1)}
      {value}
      {stepper(1)}
    </div>
  );
}
