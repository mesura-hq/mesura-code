import type { EnvironmentId } from "@t3tools/contracts";
import {
  CheckIcon,
  FolderIcon,
  GitBranchIcon,
  LockIcon,
  ScaleIcon,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Kbd } from "../ui/kbd";
import {
  resolveDigitOptionIndex,
  resolveNavigableRunContextTabs,
  stepOptionSelection,
  stepRunContextTab,
  type RunContextTab,
  type RunContextTabAvailabilityMap,
} from "./runContextDrawer.logic";

export interface RunContextWorkspaceOption {
  value: string;
  label: string;
  Icon: LucideIcon;
}

interface RunContextOption {
  value: string;
  label: string;
  icon: ReactNode;
}

export interface RunContextDrawerProps {
  activeTab: RunContextTab | null;
  onActiveTabChange: (tab: RunContextTab) => void;
  onClose: (options: { focusComposer: boolean }) => void;
  availability: RunContextTabAvailabilityMap;
  // Host tab. Automatic routing is a Settings choice (load balancing), not a
  // host: the list offers real hosts only, and the label is shown while a
  // draft still routes automatically.
  environments: readonly EnvironmentOption[];
  /** The draft's machine, for the tab summary even when it is not offered. */
  currentHost: EnvironmentOption | null;
  environmentId: EnvironmentId;
  autoEnvironmentLabel: string | undefined;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  // Workspace tab
  workspaceOptions: readonly RunContextWorkspaceOption[];
  selectedWorkspace: string;
  lockedWorkspaceLabel: string;
  onWorkspaceSelect: (value: string) => void;
  // Branch tab: the inline branch selector supplies its label and its panel.
  branchLabel: string | null;
  branchPanel: ReactNode;
  // Shortcut labels for the hints; null when unbound.
  cycleMachineShortcut: string | null;
  toggleWorkspaceShortcut: string | null;
}

/**
 * Host, workspace and branch as three tabs in one keyboard-first surface. It
 * opens inside the composer's context strip, so the strip grows and the
 * composer moves up. The tab bar doubles as the summary of the current choice.
 *
 * One pass: open, choose the host, Tab, choose the workspace, Enter. Host and
 * workspace changes apply at once, because they only edit the draft. A branch
 * waits for Enter, because choosing one can run a checkout.
 */
export function RunContextDrawer(props: RunContextDrawerProps) {
  const {
    activeTab,
    onActiveTabChange,
    onClose,
    availability,
    environments,
    currentHost,
    environmentId,
    autoEnvironmentLabel,
    onEnvironmentChange,
    workspaceOptions,
    selectedWorkspace,
    lockedWorkspaceLabel,
    onWorkspaceSelect,
    branchLabel,
    branchPanel,
    cycleMachineShortcut,
    toggleWorkspaceShortcut,
  } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const navigableTabs = resolveNavigableRunContextTabs(availability);

  const hostOptions: RunContextOption[] = environments.map((environment) => ({
    value: environment.environmentId as string,
    label: environment.label,
    icon: <EnvironmentMachineIcon kind={environment.machine} className="size-3.5 shrink-0" />,
  }));
  const workspaceListOptions: RunContextOption[] = workspaceOptions.map((option) => ({
    value: option.value,
    label: option.label,
    icon: <option.Icon className="size-3.5 shrink-0" />,
  }));
  // While a draft routes automatically, no host is chosen yet.
  const selectedHost = autoEnvironmentLabel ? null : (environmentId as string);
  const activeHostOption = hostOptions.find((option) => option.value === selectedHost) ?? null;
  const activeWorkspaceOption =
    workspaceListOptions.find((option) => option.value === selectedWorkspace) ?? null;
  const LockedWorkspaceIcon =
    workspaceOptions.find((option) => option.value === selectedWorkspace)?.Icon ?? FolderIcon;

  // WORKAROUND: a machine change re-seeds the composer's Lexical editor, and
  // setting its DOM selection moves focus into it without any focus() call, so
  // the drawer loses the keyboard mid-navigation. For a short window after the
  // drawer itself changes machine, focus that lands outside it is taken back.
  // Remove once the composer stops claiming focus when its draft context
  // changes (an upstream composer behavior, out of scope for the prototype).
  const reclaimFocusUntilRef = useRef(0);
  const selectHost = useCallback(
    (value: string) => {
      reclaimFocusUntilRef.current = performance.now() + 600;
      // From automatic routing, choosing the host it picked still pins it.
      if (value !== environmentId || autoEnvironmentLabel) {
        onEnvironmentChange?.(value as EnvironmentId);
      }
    },
    [autoEnvironmentLabel, environmentId, onEnvironmentChange],
  );

  const tabOptions = (tab: RunContextTab): readonly RunContextOption[] =>
    tab === "host" ? hostOptions : tab === "workspace" ? workspaceListOptions : [];
  const tabSelection = (tab: RunContextTab): string | null =>
    tab === "host" ? selectedHost : tab === "workspace" ? selectedWorkspace : null;
  const selectInTab = (tab: RunContextTab, value: string) => {
    if (tab === "host") selectHost(value);
    if (tab === "workspace" && value !== selectedWorkspace) onWorkspaceSelect(value);
  };

  // The keyboard follows the selection: the selected option of the active tab
  // holds focus, and the branch tab hands it to its search field. A machine
  // change re-renders the strip, so this runs on selection changes too.
  const focusActiveTab = useCallback(() => {
    if (activeTab === null) {
      rootRef.current?.focus({ preventScroll: true });
      return;
    }
    if (activeTab === "branch") {
      focusBranchSearchField(rootRef.current);
      return;
    }
    const selection = activeTab === "host" ? selectedHost : selectedWorkspace;
    const option =
      optionRefs.current.get(`${activeTab}:${selection}`) ??
      rootRef.current?.querySelector<HTMLButtonElement>("[data-run-context-panel] button");
    option?.focus({ preventScroll: true });
  }, [activeTab, selectedHost, selectedWorkspace]);
  useLayoutEffect(focusActiveTab, [focusActiveTab]);
  useEffect(() => {
    const handler = (event: FocusEvent) => {
      if (performance.now() > reclaimFocusUntilRef.current) return;
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      focusActiveTab();
    };
    document.addEventListener("focusin", handler, true);
    return () => document.removeEventListener("focusin", handler, true);
  }, [focusActiveTab]);

  useStripExtension(rootRef);
  useCloseOnOutsidePress(rootRef, onClose);

  const moveToTab = (tab: RunContextTab) => {
    // flushSync so the branch search field exists before a typed key lands.
    flushSync(() => onActiveTabChange(tab));
  };
  const stepTab = (delta: 1 | -1, wrap: boolean) => {
    if (activeTab === null) return;
    moveToTab(stepRunContextTab({ navigableTabs, currentTab: activeTab, delta, wrap }));
  };

  const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose({ focusComposer: true });
      return;
    }
    // Tab moves between tabs everywhere, the branch search field included.
    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      stepTab(event.shiftKey ? -1 : 1, true);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The branch tab's search field owns its keys; it leaves through Tab and
    // Escape, which the capture handler takes.
    if (activeTab === null || activeTab === "branch") return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case "Enter": {
        event.preventDefault();
        onClose({ focusComposer: true });
        return;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        stepTab(event.key === "ArrowRight" ? 1 : -1, false);
        return;
      }
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        const next = stepOptionSelection({
          values: tabOptions(activeTab).map((option) => option.value),
          selected: tabSelection(activeTab),
          delta: event.key === "ArrowDown" ? 1 : -1,
        });
        if (next !== null) selectInTab(activeTab, next);
        return;
      }
    }

    const digitIndex = resolveDigitOptionIndex(event.key);
    if (digitIndex !== null) {
      event.preventDefault();
      const option = tabOptions(activeTab)[digitIndex];
      if (option !== undefined) selectInTab(activeTab, option.value);
      return;
    }

    // Any other printable key starts a branch search with that key. The key
    // is not prevented: focus moves first, so the character lands in the field.
    if (event.key.length === 1 && event.key !== " " && navigableTabs.includes("branch")) {
      moveToTab("branch");
      focusBranchSearchField(rootRef.current);
    }
  };

  const registerOption = (key: string) => (element: HTMLButtonElement | null) => {
    if (element) optionRefs.current.set(key, element);
    else optionRefs.current.delete(key);
  };

  const renderOptionList = (tab: "host" | "workspace", options: readonly RunContextOption[]) => (
    <div
      role="radiogroup"
      aria-label={tab === "host" ? "Host" : "Workspace"}
      className="flex flex-col gap-0.5"
    >
      {options.map((option, index) => (
        <RunContextOptionRow
          key={option.value}
          ref={registerOption(`${tab}:${option.value}`)}
          selected={tabSelection(tab) === option.value}
          digit={index + 1}
          icon={option.icon}
          label={option.label}
          onSelect={() => {
            onActiveTabChange(tab);
            selectInTab(tab, option.value);
          }}
        />
      ))}
    </div>
  );

  const hostReadOnlyIcon = (
    <EnvironmentMachineIcon kind={currentHost?.machine ?? "server"} className="size-3.5 shrink-0" />
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-run-context-drawer=""
      role="group"
      aria-label="Run context"
      className="order-first flex min-w-0 max-w-full basis-full flex-col pb-1 outline-none"
      onKeyDownCapture={handleKeyDownCapture}
      onKeyDown={handleKeyDown}
    >
      <div role="tablist" aria-label="Run context" className="flex min-w-0 gap-1 px-1">
        {availability.host.visible ? (
          <RunContextTabButton
            tab="host"
            label="Host"
            value={autoEnvironmentLabel ?? currentHost?.label ?? "This machine"}
            icon={
              autoEnvironmentLabel ? (
                <ScaleIcon className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                (activeHostOption?.icon ?? hostReadOnlyIcon)
              )
            }
            active={activeTab === "host"}
            editable={availability.host.editable}
            onSelect={() => onActiveTabChange("host")}
          />
        ) : null}
        {availability.workspace.visible ? (
          <RunContextTabButton
            tab="workspace"
            label="Workspace"
            value={
              availability.workspace.editable
                ? (activeWorkspaceOption?.label ?? lockedWorkspaceLabel)
                : lockedWorkspaceLabel
            }
            icon={
              activeWorkspaceOption?.icon ?? <LockedWorkspaceIcon className="size-3.5 shrink-0" />
            }
            active={activeTab === "workspace"}
            editable={availability.workspace.editable}
            onSelect={() => onActiveTabChange("workspace")}
          />
        ) : null}
        {availability.branch.visible ? (
          <RunContextTabButton
            tab="branch"
            label="Branch"
            value={branchLabel ?? "Branch"}
            icon={<GitBranchIcon className="size-3.5 shrink-0 opacity-70" />}
            active={activeTab === "branch"}
            editable={availability.branch.editable}
            onSelect={() => moveToTab("branch")}
          />
        ) : null}
      </div>

      {/* One fixed height for every tab, so Tab never moves the composer. */}
      <div
        data-run-context-panel=""
        role="tabpanel"
        className={cn(
          "mt-1 h-48 min-h-0 overflow-y-auto overscroll-contain rounded-lg bg-accent/30 p-1",
          // The drawer uses no accent colour: an on switch fills with the
          // foreground, and the thumb position still shows its state.
          "[&_[data-slot=switch][data-checked]]:bg-foreground/70",
        )}
      >
        {activeTab === "host" ? renderOptionList("host", hostOptions) : null}
        {activeTab === "workspace" ? renderOptionList("workspace", workspaceListOptions) : null}
        {activeTab === "branch" ? branchPanel : null}
        {activeTab === null ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground/70">
            This thread already started, so its host and workspace are fixed.
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2 px-2 pt-1 text-[10px] text-muted-foreground/60">
        <span className="hidden min-w-0 flex-1 truncate pointer-fine:inline">
          <Kbd className="h-4 min-w-4 text-[10px]">tab</Kbd> next ·{" "}
          <Kbd className="h-4 min-w-4 text-[10px]">↑↓</Kbd> choose ·{" "}
          <Kbd className="h-4 min-w-4 text-[10px]">1–9</Kbd> pick ·{" "}
          <Kbd className="h-4 min-w-4 text-[10px]">↵</Kbd> done ·{" "}
          <Kbd className="h-4 min-w-4 text-[10px]">esc</Kbd> close
          {activeTab === "host" && cycleMachineShortcut
            ? ` · ${cycleMachineShortcut} cycles hosts`
            : ""}
          {activeTab === "workspace" && toggleWorkspaceShortcut
            ? ` · ${toggleWorkspaceShortcut} flips workspace`
            : ""}
        </span>
        <span className="flex-1 pointer-fine:hidden" />
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-foreground/80 outline-none hover:bg-accent/60 focus-visible:bg-accent/60"
          onClick={() => onClose({ focusComposer: true })}
        >
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Focuses the branch search field from the DOM. The panel is part of the
 * drawer's own tree, so this works the moment the panel commits, before any
 * parent imperative handle exists: a drawer that opens straight on Branch
 * would otherwise leave the keyboard outside it.
 */
function focusBranchSearchField(root: HTMLElement | null) {
  root
    ?.querySelector<HTMLInputElement>("[data-run-context-panel] input")
    ?.focus({ preventScroll: true });
}

function RunContextTabButton(props: {
  tab: RunContextTab;
  label: string;
  value: string;
  icon: ReactNode;
  active: boolean;
  editable: boolean;
  onSelect: () => void;
}) {
  const { tab, label, value, icon, active, editable, onSelect } = props;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-run-context-tab={tab}
      // The panel's option or search field holds focus, not the tab itself.
      tabIndex={-1}
      disabled={!editable}
      onClick={onSelect}
      className={cn(
        // Contrast alone marks the active tab: full-strength text on a faint
        // raised fill, against dimmed neighbours. No accent colour.
        "flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 pt-1 pb-1.5 text-left outline-none transition-colors",
        active
          ? "bg-accent/50 text-foreground"
          : "text-muted-foreground/60 hover:text-foreground/80",
        !editable && "cursor-default opacity-70 hover:bg-transparent",
      )}
    >
      <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide opacity-70">
        {label}
        {!editable ? <LockIcon className="size-2.5" aria-label="Read-only" /> : null}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-xs">
        {icon}
        <span className="min-w-0 truncate">{value}</span>
      </span>
    </button>
  );
}

function RunContextOptionRow(props: {
  ref: (element: HTMLButtonElement | null) => void;
  selected: boolean;
  digit: number;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  const { ref, selected, digit, icon, label, onSelect } = props;
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      // Roving focus: only the selected option is a Tab stop; arrows move it.
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
        selected
          ? "bg-background text-foreground shadow-xs dark:bg-white/10"
          : "text-muted-foreground/70 hover:bg-accent/60 hover:text-foreground/85",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <CheckIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" /> : null}
      {digit <= 9 ? (
        <span className="hidden w-3 text-right text-[10px] tabular-nums text-muted-foreground/50 pointer-fine:inline">
          {digit}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The composer shell draws one glass backdrop whose lower part narrows to the
 * strip, using `--chat-composer-context-extension` as the strip's height. The
 * drawer makes the strip taller, so the shell has to learn the real height.
 */
function useStripExtension(rootRef: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const strip = rootRef.current?.closest<HTMLElement>('[data-slot="composer-context-strip"]');
    const shell = strip?.closest<HTMLElement>('[data-slot="composer-shell"]');
    if (!strip || !shell) return;
    const update = () => {
      // The strip tucks under the composer with a negative top margin; only
      // the part below the composer is extension.
      const overlap = Number.parseFloat(getComputedStyle(strip).marginTop) || 0;
      shell.style.setProperty(
        "--chat-composer-context-extension",
        `${Math.max(0, strip.offsetHeight + overlap)}px`,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--chat-composer-context-extension");
    };
  }, [rootRef]);
}

/** A press outside the drawer and its strip closes it, leaving focus alone. */
function useCloseOnOutsidePress(
  rootRef: React.RefObject<HTMLDivElement | null>,
  onClose: (options: { focusComposer: boolean }) => void,
) {
  useEffect(() => {
    const handler = (event: PointerEvent) => {
      const strip = rootRef.current?.closest('[data-slot="composer-context-strip"]');
      if (!strip || !(event.target instanceof Node)) return;
      if (strip.contains(event.target)) return;
      // Floating layers opened from inside the drawer (a tooltip, a toast)
      // portal elsewhere; a press there is not a press outside.
      if (event.target instanceof Element && event.target.closest("[data-base-ui-portal]")) return;
      onClose({ focusComposer: false });
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [onClose, rootRef]);
}
