import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { ChevronLeftIcon, ChevronRightIcon, StarIcon } from "lucide-react";
import type { SyntheticEvent } from "react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";

export interface ModelListRowEffort {
  label: string;
  canDecrease: boolean;
  canIncrease: boolean;
  readOnlyReason: string | null;
}

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  /**
   * Inline effort for the combined picker. Omitted outside it and for models
   * whose provider exposes no effort control.
   */
  effort?: ModelListRowEffort | null;
  onStepEffort?: (instanceId: ProviderInstanceId, slug: string, direction: 1 | -1) => void;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  const displayName = props.useTriggerLabel
    ? getTriggerDisplayModelLabel(props.model)
    : getDisplayModelName(
        props.model,
        props.preferShortName ? { preferShortName: true } : undefined,
      );

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.model.slug)}
      disabled={Boolean(props.disabledReason)}
      contentClassName="flex w-full items-center gap-3"
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer rounded-md px-2 py-2 transition-[background-color,box-shadow,color]",
        "hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] data-highlighted:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] data-selected:bg-foreground/[0.08] data-selected:text-foreground data-selected:ring-0 [&[data-highlighted][data-selected]]:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))]",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:hover:bg-transparent",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug">{displayName}</div>
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-[10px] font-bold uppercase leading-none tracking-wide text-update-foreground"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
          {props.unavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.jumpLabel ? (
          <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">{props.jumpLabel}</Kbd>
        ) : null}
        {props.effort ? (
          <ModelRowEffort
            effort={props.effort}
            modelName={displayName}
            disabled={Boolean(props.disabledReason)}
            onStep={(direction) =>
              props.onStepEffort?.(props.instanceId, props.model.slug, direction)
            }
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className={cn(
                  "-mr-1 shrink-0 text-muted-foreground/70 opacity-64 transition-[color,opacity] hover:text-foreground hover:opacity-100 group-hover:opacity-100",
                  props.isFavorite && "text-foreground opacity-100",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-yellow-500",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center" className="max-w-64 text-balance leading-snug">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});

/** Keeps a stepper press from selecting the row or moving focus out of search. */
function stopRowSelection(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

const EFFORT_STEPPER_CLASS_NAME =
  "flex size-4 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-30";

function ModelRowEffort(props: {
  effort: ModelListRowEffort;
  modelName: string;
  disabled: boolean;
  onStep: (direction: 1 | -1) => void;
}) {
  const { effort } = props;
  const value = (
    <span
      data-combined-picker-effort-value
      className="min-w-10 truncate text-center text-[11px] leading-none text-muted-foreground"
    >
      {effort.label}
    </span>
  );
  if (effort.readOnlyReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger render={<div className="flex max-w-24 shrink-0 items-center" />}>
          {value}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-64 text-balance leading-snug">
          {effort.readOnlyReason}
        </TooltipPopup>
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
