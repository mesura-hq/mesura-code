import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { ModelListRow, type ModelListRowEffort } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { Button } from "../ui/button";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { subscribePickerAction } from "../../lib/pickerActionBus";
import { CombinedPickerOptions } from "./CombinedPickerOptions";
import {
  buildCombinedPickerCandidate,
  createCombinedPickerState,
  resolveCombinedPickerRow,
  setCombinedPickerOption,
  setCombinedPickerRuntimeMode,
  stepCombinedPickerEffort,
  type CombinedPickerConfig,
  type CombinedPickerRowInput,
} from "./combinedPickerState";
import { getDisplayModelName } from "./providerIconUtils";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

export function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    (input.entry.driverKind === "opencode" || input.entry.driverKind === "antigravity") &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

export function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}

export function adjacentModelPickerProvider(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  selectedInstanceId: ProviderInstanceId | "favorites";
  direction: 1 | -1;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
}) {
  const providers: Array<ProviderInstanceId | "favorites"> = [
    "favorites",
    ...input.entries
      .filter(
        (entry) =>
          !input.disabledInstanceIds?.has(entry.instanceId) &&
          (isProviderInstancePickerReady(entry) ||
            input.selectableUnavailableInstanceIds?.has(entry.instanceId)),
      )
      .map((entry) => entry.instanceId),
  ];
  const index = providers.indexOf(input.selectedInstanceId);
  return providers[
    index < 0
      ? input.direction === 1
        ? 0
        : providers.length - 1
      : (index + input.direction + providers.length) % providers.length
  ]!;
}

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();

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

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** Adds inline effort, More options, and access; applies a complete choice. */
  combined?: CombinedPickerConfig;
  /** The trigger's viewport rect, so the combined picker can fit beside it. */
  getAnchorRect?: () => DOMRect | null;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    combined,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  // Combined picker: the pending edits of this opening. Dismissal unmounts
  // this content, which discards them.
  const [pickerState, setPickerState] = useState(() =>
    combined ? createCombinedPickerState(combined.readSavedSelection()) : null,
  );
  // More options edits the last highlighted model. The highlight is tracked in
  // a ref and copied into state only while the section is open, so hovering
  // the list does not re-render the picker. A highlight cleared by the pointer
  // leaving the list keeps the previous model.
  const lastHighlightedModelKeyRef = useRef<string | null>(null);
  const [extrasTargetKey, setExtrasTargetKey] = useState<string | null>(null);
  const [extrasExpanded, setExtrasExpanded] = useState(combined?.initialExtrasExpanded === true);
  const [effortAnnouncement, setEffortAnnouncement] = useState("");
  const extrasRegionId = useId();
  const extrasRegionRef = useRef<HTMLDivElement>(null);
  const extrasToggleRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const favorites = useClientSettings((s) => s.favorites ?? []);
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const activeInstanceHasSelectableUnavailableModel =
    activeEntry !== undefined &&
    (modelOptionsByInstance.get(props.activeInstanceId) ?? []).some((option) =>
      shouldIncludeModelPickerOption({
        entry: activeEntry,
        option,
        activeInstanceId: props.activeInstanceId,
        activeModel: activeModelSlug,
      }),
    ) &&
    !isProviderInstancePickerReady(activeEntry);
  const activeInstanceNeedsSetup =
    props.onOpenProviderSetup !== undefined &&
    activeEntry !== undefined &&
    shouldOfferModelPickerSetup(
      activeEntry,
      modelOptionsByInstance.get(props.activeInstanceId) ?? [],
    );
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "favorites">(
    () => {
      if (
        props.lockedProvider !== null ||
        activeInstanceHasSelectableUnavailableModel ||
        activeInstanceNeedsSetup
      ) {
        // Keep the active instance visible when it is locked or needs setup.
        return props.activeInstanceId;
      }
      return favorites.length > 0 ? "favorites" : props.activeInstanceId;
    },
  );
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        modelOptionsByInstance
          .get(props.activeInstanceId)
          ?.some((model) => model.slug === activeModelSlug && model.isLegacy)
          ? [props.activeInstanceId]
          : [],
      ),
  );
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const updateSettings = useUpdateClientSettings();

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectInstance = useCallback(
    (instanceId: ProviderInstanceId | "favorites") => {
      setSelectedInstanceId(instanceId);
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput],
  );

  // The first control in More options, or its toggle when it has none.
  const focusExtras = useCallback(() => {
    const target =
      extrasRegionRef.current?.querySelector<HTMLElement>(
        "select:not(:disabled), button:not(:disabled), input:not(:disabled), [role='switch']",
      ) ?? extrasToggleRef.current;
    target?.focus({ preventScroll: true });
  }, []);
  const opensOnExtras = combined?.initialExtrasExpanded === true;

  useLayoutEffect(() => {
    const focusInitialTarget = opensOnExtras ? focusExtras : focusSearchInput;
    focusInitialTarget();
    const frame = window.requestAnimationFrame(() => {
      focusInitialTarget();
    });
    const timeout = window.setTimeout(() => {
      focusInitialTarget();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusExtras, focusSearchInput, opensOnExtras]);

  // WORKAROUND (see MODEL_PICKER_VIEWPORT_MARGIN_PX): size the combined
  // picker to the larger side of its trigger. This layout effect runs before
  // Base UI's measurement, because the popup is an ancestor of this content.
  const isCombined = combined !== undefined;
  const getAnchorRect = props.getAnchorRect;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!isCombined || !root || !getAnchorRect) return;
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
  }, [getAnchorRect, isCombined]);

  // Create a Set for efficient lookup. Favorites are keyed by
  // `${instanceId}:${slug}`; the storage schema widened from ProviderDriverKind
  // to ProviderInstanceId so pre-migration favorites keyed by driver slugs
  // (e.g. `"codex:gpt-5"`) still resolve — the default instance id equals
  // the driver slug.
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  }, [favorites]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  // Each row's catalog entry, indexed once per catalog update. A row resolves
  // its options against this one-entry catalog, so pending effort edits never
  // scan an instance's whole catalog per mounted row.
  const catalogEntryByModelKey = useMemo(() => {
    const index = new Map<string, ReadonlyArray<ServerProviderModel>>();
    for (const entry of instanceEntries) {
      for (const model of entry.models) {
        index.set(modelPickerModelKey(entry.instanceId, model.slug), [model]);
      }
    }
    return index;
  }, [instanceEntries]);
  const combinedRowInput = useCallback(
    (instanceId: ProviderInstanceId, slug: string): CombinedPickerRowInput | null => {
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
    },
    [catalogEntryByModelKey, entryByInstanceId],
  );
  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  const selectableUnavailableInstanceIds = useMemo(() => {
    const instanceIds = new Set<ProviderInstanceId>();
    if (activeInstanceHasSelectableUnavailableModel) {
      instanceIds.add(props.activeInstanceId);
    }
    if (props.onOpenProviderSetup) {
      for (const entry of instanceEntries) {
        if (
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? [])
        ) {
          instanceIds.add(entry.instanceId);
        }
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  }, [
    activeInstanceHasSelectableUnavailableModel,
    instanceEntries,
    modelOptionsByInstance,
    props.activeInstanceId,
    props.onOpenProviderSetup,
  ]);

  // Flatten models into a searchable array. One pass over the
  // instance-keyed map; each model carries its instance id + driver kind
  // so the list row can render the right icon and display name without
  // another lookup.
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        // Instance disappeared between renders (configuration change). Skip
        // its models — stale options shouldn't appear in the picker.
        continue;
      }
      for (const model of models) {
        if (
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  }, [modelOptionsByInstance, entryByInstanceId, props.activeInstanceId, activeModelSlug]);

  const isLocked = props.lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  const lockedDisabledInstanceIds = useMemo(() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const sidebarInstanceEntries = useMemo(() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return enabledEntries;
    }
    const available: ProviderInstanceEntry[] = [];
    const disabled: ProviderInstanceEntry[] = [];
    for (const entry of enabledEntries) {
      if (matchesLockedProvider(entry)) {
        available.push(entry);
      } else {
        disabled.push(entry);
      }
    }
    return [...available, ...disabled];
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const showSidebar = !isSearching && sidebarInstanceEntries.length > 0;
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );

  // Filter models based on search query and selected instance
  const filteredModels = useMemo(() => {
    let result = flatModels;

    // Apply tokenized fuzzy search across the combined provider/model search fields.
    if (searchQuery.trim()) {
      const rankedMatches = result
        .map((model) => ({
          model,
          score: scoreModelPickerSearch(
            {
              name: model.name,
              ...(model.shortName ? { shortName: model.shortName } : {}),
              ...(model.subProvider ? { subProvider: model.subProvider } : {}),
              driverKind: model.driverKind,
              providerDisplayName: model.instanceDisplayName,
              isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
            },
            searchQuery,
          ),
          isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
          tieBreaker: buildModelPickerSearchText({
            name: model.name,
            ...(model.shortName ? { shortName: model.shortName } : {}),
            ...(model.subProvider ? { subProvider: model.subProvider } : {}),
            driverKind: model.driverKind,
            providerDisplayName: model.instanceDisplayName,
          }),
        }))
        .filter(
          (
            rankedModel,
          ): rankedModel is {
            model: ModelPickerItem;
            score: number;
            isFavorite: boolean;
            tieBreaker: string;
          } => rankedModel.score !== null,
        );

      // When searching, we only respect locked provider (by driver kind),
      // ignoring sidebar selection so account-scoped searches can find a
      // model before the user chooses a specific instance rail item.
      if (props.lockedProvider !== null) {
        const lockedProviderMatches: Array<(typeof rankedMatches)[number]> = [];
        for (const rankedModel of rankedMatches) {
          if (matchesLockedProvider(rankedModel.model)) {
            lockedProviderMatches.push(rankedModel);
          }
        }
        return lockedProviderMatches
          .toSorted((a, b) => {
            const scoreDelta = a.score - b.score;
            if (scoreDelta !== 0) {
              return scoreDelta;
            }
            if (a.isFavorite !== b.isFavorite) {
              return a.isFavorite ? -1 : 1;
            }
            return a.tieBreaker.localeCompare(b.tieBreaker);
          })
          .map((rankedModel) => rankedModel.model);
      }

      return rankedMatches
        .toSorted((a, b) => {
          const scoreDelta = a.score - b.score;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
          if (a.isFavorite !== b.isFavorite) {
            return a.isFavorite ? -1 : 1;
          }
          return a.tieBreaker.localeCompare(b.tieBreaker);
        })
        .map((rankedModel) => rankedModel.model);
    }

    if (props.lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
      if (selectedInstanceId === "favorites") {
        result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
      } else {
        result = result.filter((m) => m.instanceId === selectedInstanceId);
      }
    } else if (selectedInstanceId === "favorites") {
      result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }

    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedInstanceId !== "favorites",
      instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],
    });
  }, [
    favoritesSet,
    flatModels,
    instanceOrder,
    matchesLockedProvider,
    props.lockedProvider,
    searchQuery,
    selectedInstanceId,
  ]);

  const legacySection = useMemo(() => {
    if (isSearching || selectedInstanceId === "favorites") {
      return null;
    }
    const currentModels = filteredModels.filter((model) => !model.isLegacy);
    const legacyModels = filteredModels.filter((model) => model.isLegacy);
    if (legacyModels.length === 0) {
      return null;
    }
    return {
      key: modelPickerLegacySectionKey(selectedInstanceId),
      currentModels,
      legacyModels,
      isExpanded: expandedLegacyInstances.has(selectedInstanceId),
    };
  }, [expandedLegacyInstances, filteredModels, isSearching, selectedInstanceId]);

  const visibleModels = useMemo(() => {
    if (!legacySection) {
      return filteredModels;
    }
    return [
      ...legacySection.currentModels,
      ...(legacySection.isExpanded ? legacySection.legacyModels : []),
    ];
  }, [filteredModels, legacySection]);

  const selectedEntry =
    selectedInstanceId === "favorites" ? undefined : entryByInstanceId.get(selectedInstanceId);
  const providerSetupEntries =
    !isSearching && props.onOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            matchesLockedProvider(entry) &&
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
            ) &&
            (selectedEntry
              ? entry.instanceId === selectedEntry.instanceId
              : filteredModels.length === 0),
        )
      : [];

  const toggleLegacySection = useCallback((instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  }, []);

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId) => {
      if (getModelDisabledReason?.(instanceId, modelSlug)) {
        return;
      }
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (!resolvedModel) {
        return;
      }
      const row = combined && pickerState ? combinedRowInput(instanceId, modelSlug) : null;
      if (combined && pickerState && row) {
        // Apply the row's whole pending choice; the caller validates it
        // before writing anything.
        const candidate = buildCombinedPickerCandidate(
          pickerState,
          row,
          combined.context,
          combined.readCurrentPrompt(),
        );
        combined.onApply({
          ...candidate,
          modelSelection: { ...candidate.modelSelection, model: resolvedModel },
        });
        return;
      }
      onInstanceModelChange(instanceId, resolvedModel);
    },
    [
      combined,
      combinedRowInput,
      entryByInstanceId,
      getModelDisabledReason,
      modelOptionsByInstance,
      onInstanceModelChange,
      pickerState,
    ],
  );

  const toggleFavorite = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === instanceId && f.model === model);
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider: instanceId, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [favorites, updateSettings],
  );

  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    let selectableModelIndex = 0;
    for (const model of visibleModels) {
      if (getModelDisabledReason?.(model.instanceId, model.slug)) {
        continue;
      }
      const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(modelPickerModelKey(model.instanceId, model.slug), jumpCommand);
      selectableModelIndex += 1;
    }
    return mapping;
  }, [getModelDisabledReason, visibleModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allItemKeys = useMemo(
    (): string[] => [
      ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
      ...new Set(
        flatModels
          .filter((model) => model.isLegacy)
          .map((model) => modelPickerLegacySectionKey(model.instanceId)),
      ),
    ],
    [flatModels],
  );
  const filteredItemKeys = useMemo((): string[] => {
    const modelKeys = visibleModels.map((model) =>
      modelPickerModelKey(model.instanceId, model.slug),
    );
    if (!legacySection) {
      return modelKeys;
    }
    modelKeys.splice(legacySection.currentModels.length, 0, legacySection.key);
    return modelKeys;
  }, [legacySection, visibleModels]);
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(
        visibleModels.map(
          (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
        ),
      ),
    [visibleModels],
  );
  const stepEffort = useCallback(
    (instanceId: ProviderInstanceId, slug: string, direction: 1 | -1) => {
      if (!combined || !pickerState || getModelDisabledReason?.(instanceId, slug)) return;
      const row = combinedRowInput(instanceId, slug);
      if (!row) return;
      const next = stepCombinedPickerEffort(pickerState, row, combined.context, direction);
      if (next === pickerState) return;
      setPickerState(next);
      const effort = resolveCombinedPickerRow(next, row, combined.context).effort;
      const model = filteredModelByKey.get(modelPickerModelKey(instanceId, slug));
      setEffortAnnouncement(`${model?.name ?? slug} effort ${effort?.label ?? ""}`);
    },
    [combined, combinedRowInput, filteredModelByKey, getModelDisabledReason, pickerState],
  );
  const rememberHighlightedModel = useCallback(
    (modelKey: string) => {
      lastHighlightedModelKeyRef.current = modelKey;
      if (extrasExpanded) setExtrasTargetKey(modelKey);
    },
    [extrasExpanded],
  );
  const stepEffortFromPointer = useCallback(
    (instanceId: ProviderInstanceId, slug: string, direction: 1 | -1) => {
      rememberHighlightedModel(modelPickerModelKey(instanceId, slug));
      stepEffort(instanceId, slug, direction);
    },
    [rememberHighlightedModel, stepEffort],
  );

  const updateModelListScrollFades = useCallback(() => {
    const scrollElement = modelListRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);
  // Pending effort lives outside the row data, so the virtual list re-renders
  // its mounted rows when it changes.
  const modelListExtraData = useMemo(
    () => ({ favoritesSet, modelJumpLabelByKey, pickerState }),
    [favoritesSet, modelJumpLabelByKey, pickerState],
  );
  const resolveRowEffort = (model: ModelPickerItem): ModelListRowEffort | null => {
    if (!combined || !pickerState) return null;
    const row = combinedRowInput(model.instanceId, model.slug);
    const effort = row ? resolveCombinedPickerRow(pickerState, row, combined.context).effort : null;
    return effort
      ? {
          label: effort.label ?? "Default",
          canDecrease: effort.canDecrease,
          canIncrease: effort.canIncrease,
          readOnlyReason: effort.readOnlyReason,
        }
      : null;
  };
  const extrasTarget = (() => {
    if (!combined || !pickerState || !extrasExpanded) return null;
    // Only a model the current search and provider show can be the target.
    const model =
      (extrasTargetKey ? filteredModelByKey.get(extrasTargetKey) : undefined) ??
      (activeModelKey ? filteredModelByKey.get(activeModelKey) : undefined);
    const row = model ? combinedRowInput(model.instanceId, model.slug) : null;
    if (!model || !row) return null;
    return {
      model,
      row,
      modelName: getDisplayModelName(model, isLocked ? undefined : { preferShortName: true }),
      providerName: model.instanceDisplayName,
      optionState: resolveCombinedPickerRow(pickerState, row, combined.context).optionState,
    };
  })();
  const extrasShortcutLabel = combined
    ? shortcutLabelForCommand(keybindings, "traitsPicker.toggle")
    : null;

  const selectAdjacentProvider = useCallback(
    (direction: 1 | -1) => {
      const next = adjacentModelPickerProvider({
        entries: sidebarInstanceEntries,
        selectedInstanceId,
        direction,
        disabledInstanceIds: lockedDisabledInstanceIds,
        selectableUnavailableInstanceIds,
      });
      setSearchQuery("");
      handleSelectInstance(next);
    },
    [
      handleSelectInstance,
      lockedDisabledInstanceIds,
      selectableUnavailableInstanceIds,
      selectedInstanceId,
      sidebarInstanceEntries,
    ],
  );

  // More options: the traits shortcut and the toggle open or close it, then
  // move focus into it or back to search after the render that shows it.
  const pendingExtrasFocusRef = useRef<"extras" | "search" | null>(null);
  const setExtras = useCallback((expanded: boolean) => {
    setExtrasExpanded(expanded);
    if (expanded) setExtrasTargetKey(lastHighlightedModelKeyRef.current);
    pendingExtrasFocusRef.current = expanded ? "extras" : "search";
  }, []);
  useLayoutEffect(() => {
    const target = pendingExtrasFocusRef.current;
    if (target === null) return;
    pendingExtrasFocusRef.current = null;
    if (target === "extras") focusExtras();
    else focusSearchInput();
  });
  useEffect(() => {
    if (!combined?.respondsToShortcut) return;
    return subscribePickerAction("traits", () => setExtras(!extrasExpanded));
  }, [combined?.respondsToShortcut, extrasExpanded, setExtras]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
        event.preventDefault();
        event.stopPropagation();
        selectAdjacentProvider(command === "modelPicker.nextProvider" ? 1 : -1);
        return;
      }
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const model = parseModelPickerModelKey(targetModelKey);
      if (!model) {
        return;
      }
      handleModelSelect(model.slug, model.instanceId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [
    handleModelSelect,
    keybindings,
    modelJumpModelKeys,
    modelJumpShortcutContext,
    selectAdjacentProvider,
  ]);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(filteredItemKeys.length > 5);
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      updateModelListScrollFades();
      nestedFrame = window.requestAnimationFrame(updateModelListScrollFades);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [filteredItemKeys, updateModelListScrollFades]);

  return (
    <TooltipProvider delay={0}>
      <div
        ref={rootRef}
        className={cn(
          "relative h-screen w-screen max-w-90 overflow-hidden",
          // Combined: the list keeps at least half the height (up to 7.5rem)
          // and More options shrinks and scrolls inside the rest.
          combined
            ? "grid grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(min(7.5rem,50%),1fr)_minmax(0,auto)]"
            : "flex max-h-86.5 flex-row",
          combined &&
            (extrasExpanded
              ? "max-h-[min(30rem,var(--model-picker-fit-height,30rem))]"
              : "max-h-[min(21.625rem,var(--model-picker-fit-height,21.625rem))]"),
        )}
        data-model-picker-content="true"
        onKeyDown={
          combined
            ? (event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                props.onRequestClose?.();
              }
            : undefined
        }
      >
        {/* Sidebar */}
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            onFocusSearch={focusSearchInput}
            instanceEntries={sidebarInstanceEntries}
            showFavorites
            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}
            {...(lockedDisabledInstanceIds
              ? {
                  disabledInstanceIds: lockedDisabledInstanceIds,
                  getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                    `${entry.displayName} is unavailable in this thread. Start a new thread to switch providers.`,
                }
              : {})}
          />
        )}

        {/* Main content area */}
        <Combobox
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          value={activeModelKey}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (combined && typeof modelKey === "string" && parseModelPickerModelKey(modelKey)) {
              rememberHighlightedModel(modelKey);
            }
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(modelKey) => {
            if (typeof modelKey !== "string") {
              return;
            }
            const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
            if (legacyInstanceId) {
              toggleLegacySection(legacyInstanceId);
              return;
            }
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(model.slug, model.instanceId);
            }
          }}
        >
          <div
            className={cn(
              "col-start-2 flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            {/* Search bar */}
            <div className="px-2 pt-2">
              <div className="border-b border-border/70 pb-2.5 transition-colors focus-within:border-ring">
                <ComboboxInput
                  ref={searchInputRef}
                  className="[&_input]:h-6.5 [&_input]:font-sans [&_input]:leading-6.5"
                  inputClassName="rounded-none bg-transparent text-sm"
                  placeholder="Search models..."
                  showTrigger={false}
                  startAddon={
                    <SearchIcon className="-translate-x-0.5 size-4 shrink-0 text-muted-foreground opacity-70" />
                  }
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      combined &&
                      !e.altKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      // Combined mode: Tab cycles providers and plain Left/Right
                      // adjust the highlighted row's effort instead of moving
                      // the caret or focus.
                      if (e.key === "Tab") {
                        e.preventDefault();
                        e.stopPropagation();
                        selectAdjacentProvider(e.shiftKey ? -1 : 1);
                        return;
                      }
                      const highlightedModel =
                        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
                        !e.shiftKey &&
                        highlightedModelKeyRef.current
                          ? parseModelPickerModelKey(highlightedModelKeyRef.current)
                          : null;
                      if (highlightedModel) {
                        e.preventDefault();
                        e.stopPropagation();
                        stepEffort(
                          highlightedModel.instanceId,
                          highlightedModel.slug,
                          e.key === "ArrowRight" ? 1 : -1,
                        );
                        return;
                      }
                    }
                    if (
                      !combined &&
                      showSidebar &&
                      !e.altKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) ||
                        (e.key === "Tab" && e.shiftKey))
                    ) {
                      const sidebar = e.currentTarget
                        .closest("[data-model-picker-content]")
                        ?.querySelector("[data-model-picker-sidebar]");
                      const button =
                        sidebar?.querySelector<HTMLButtonElement>(
                          'button[aria-pressed="true"]:not(:disabled)',
                        ) ?? sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                      if (button) {
                        e.preventDefault();
                        e.stopPropagation();
                        button.focus();
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      props.onRequestClose?.();
                      return;
                    }
                    if (e.key === "Enter" && highlightedModelKeyRef.current) {
                      (
                        e as typeof e & { preventBaseUIHandler?: () => void }
                      ).preventBaseUIHandler?.();
                      e.preventDefault();
                      e.stopPropagation();
                      const legacyInstanceId = parseModelPickerLegacySectionKey(
                        highlightedModelKeyRef.current,
                      );
                      if (legacyInstanceId) {
                        toggleLegacySection(legacyInstanceId);
                        return;
                      }
                      const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
                      if (model) {
                        handleModelSelect(model.slug, model.instanceId);
                      }
                      return;
                    }
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  size="sm"
                  unstyled
                />
              </div>
            </div>

            {/* Model list */}
            <div className="relative min-h-0 flex-1 overflow-hidden pr-px">
              <ComboboxListVirtualized className="size-full min-w-0 p-0 not-empty:p-0">
                <LegendList<string>
                  ref={modelListRef}
                  data={filteredItemKeys}
                  extraData={modelListExtraData}
                  keyExtractor={(modelKey) => modelKey}
                  renderItem={({ item: modelKey, index }) => {
                    if (legacySection?.key === modelKey) {
                      return (
                        <ComboboxItem
                          hideIndicator
                          index={index}
                          value={modelKey}
                          aria-expanded={legacySection.isExpanded}
                          className="group w-full cursor-pointer rounded-md px-2 py-2"
                          contentClassName="flex w-full items-center gap-3"
                        >
                          <div className="min-w-0 flex-1 text-left">
                            <div className="text-xs font-medium leading-snug">Legacy models</div>
                            <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
                              {legacySection.legacyModels.length} models
                            </div>
                          </div>
                          <ChevronRightIcon
                            className={cn(
                              "size-4 transition-transform",
                              legacySection.isExpanded && "rotate-90",
                            )}
                          />
                        </ComboboxItem>
                      );
                    }
                    const model = filteredModelByKey.get(modelKey);
                    if (!model) {
                      return null;
                    }
                    const disabledReason =
                      getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                    return (
                      <ModelListRow
                        key={modelKey}
                        index={index}
                        model={model}
                        instanceId={model.instanceId}
                        driverKind={model.driverKind}
                        providerDisplayName={model.instanceDisplayName}
                        providerAccentColor={model.instanceAccentColor}
                        isFavorite={favoritesSet.has(
                          providerModelKey(model.instanceId, model.slug),
                        )}
                        isSelected={modelKey === activeModelKey}
                        showProvider
                        preferShortName={!isLocked}
                        useTriggerLabel={false}
                        showNewBadge={model.badge === "new"}
                        unavailable={model.isUnavailable === true}
                        jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                        disabledReason={disabledReason}
                        effort={resolveRowEffort(model)}
                        onStepEffort={stepEffortFromPointer}
                        onToggleFavorite={() => toggleFavorite(model.instanceId, model.slug)}
                      />
                    );
                  }}
                  estimatedItemSize={52}
                  drawDistance={480}
                  recycleItems
                  contentContainerClassName="pl-2 pr-px"
                  ItemSeparatorComponent={ModelListSeparator}
                  onLayout={updateModelListScrollFades}
                  onScroll={updateModelListScrollFades}
                  className={cn(
                    "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
                    getVirtualizedScrollFadeClassName({
                      top: showTopScrollFade,
                      bottom: showBottomScrollFade,
                    }),
                  )}
                />
              </ComboboxListVirtualized>
            </div>
            {providerSetupEntries.length > 0 ? (
              <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
                {providerSetupEntries.map((entry) => (
                  <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
                    <p className="line-clamp-3 text-muted-foreground">
                      {getProviderStatusMessage(entry.snapshot)}
                    </p>
                    <Button
                      className="mt-1 px-0 text-foreground"
                      onClick={() => {
                        props.onRequestClose?.();
                        props.onOpenProviderSetup?.(entry.instanceId);
                      }}
                      size="xs"
                      variant="link"
                    >
                      {providerSetupEntries.length > 1
                        ? `Set up ${entry.displayName}`
                        : "Open provider setup"}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
                No models found
              </ComboboxEmpty>
            )}
          </div>
        </Combobox>
        {combined && pickerState ? (
          <div className="col-span-2 flex min-h-0 flex-col">
            <CombinedPickerOptions
              expanded={extrasExpanded}
              regionId={extrasRegionId}
              regionRef={extrasRegionRef}
              toggleRef={extrasToggleRef}
              shortcutLabel={extrasShortcutLabel}
              runtimeMode={pickerState.runtimeMode}
              target={extrasTarget}
              onToggle={() => setExtras(!extrasExpanded)}
              onRuntimeModeChange={(mode) =>
                setPickerState((current) =>
                  current ? setCombinedPickerRuntimeMode(current, mode) : current,
                )
              }
              onOptionChange={(descriptorId, value) => {
                if (!extrasTarget) return;
                setPickerState((current) =>
                  current
                    ? setCombinedPickerOption(
                        current,
                        extrasTarget.row,
                        combined.context,
                        descriptorId,
                        value,
                      )
                    : current,
                );
              }}
              onUse={() => {
                if (extrasTarget) {
                  handleModelSelect(extrasTarget.model.slug, extrasTarget.model.instanceId);
                }
              }}
            />
            <span aria-live="polite" className="sr-only">
              {effortAnnouncement}
            </span>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
});
