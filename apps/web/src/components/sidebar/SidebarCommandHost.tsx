import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand } from "@t3tools/contracts";
import { type RefObject, useEffect } from "react";
import { create } from "zustand";

import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import { useCommandHandlers } from "../../commands/commandRegistry";
import { resolveShortcutCommand } from "../../keybindings";
import { captureComposerFocusReturn } from "../../keys/composer/composerSurface";
import { focusPane, getFocusedPane, getLastFocusedPane, type PaneId } from "../../lib/paneFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { useProjectScopeStore } from "../../projectScopeStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import {
  closeAgentSearchPopupForWorkspace,
  useAgentSearchPopupStore,
} from "../searches/agentSearchPopupStore";
import { toastManager } from "../ui/toast";
import { useSidebar } from "../ui/sidebar";
import { useCloseAppModal } from "./mainAppLocation";
import { setWorkingSectionExpanded } from "./workingSection";

/**
 * The keyboard's way into the sidebar (`threadSearch.toggle`, `projectScope.toggle`,
 * `projectScope.toggleAll`, `sidebar.toggleWorking`). The request is a store, not an event, because the target may be
 * unmounted (the phone drawer) or inert (the Settings modal, an open command palette):
 * `SidebarCommandHost` opens or closes those, and the sidebar serves the request once it can.
 */
type SidebarFocusTarget = "search" | "projectFilter";

const useSidebarFocusRequestStore = create<{ target: SidebarFocusTarget | null }>()(() => ({
  target: null,
}));

/** The mounted sidebar's half, registered by `useSidebarCommandTarget`. */
let mountedTarget: {
  readonly serve: (target: SidebarFocusTarget) => void;
  readonly searchInput: () => HTMLInputElement | null;
} | null = null;

/**
 * Where `threadSearch.toggle` took the keyboard from. Captured before the
 * Search field takes focus, and forgotten when focus leaves the field any
 * other way, so a later Escape never returns to a stale place.
 */
interface SearchFocusOrigin {
  readonly element: Element | null;
  readonly pane: PaneId;
  /** Restores the composer's caret and Vim NORMAL mode, which a plain focus() loses. */
  readonly restoreComposer: (() => boolean) | null;
  /** The command showed the sidebar, so leaving the field hides it again. */
  readonly revealedSidebar: boolean;
}
let searchFocusOrigin: SearchFocusOrigin | null = null;
/** Display names by project scope key, kept by the mounted sidebar for the toggle's toast. */
const projectScopeLabels = new Map<string, string>();

const CLOSE_PALETTE_EVENT = "mesura:sidebar-request-closes-palette";

/** The command palette listens, so a sidebar request can close it without lifting its state. */
export function onSidebarRequestClosesPalette(listener: () => void): () => void {
  window.addEventListener(CLOSE_PALETTE_EVENT, listener);
  return () => window.removeEventListener(CLOSE_PALETTE_EVENT, listener);
}

/**
 * Serves a pending focus request, when the sidebar is mounted to take it.
 * Returns true while one is pending, so a closing overlay does not hand focus
 * elsewhere first; the command palette's final focus asks this.
 */
export function serveSidebarFocusRequest(): boolean {
  const { target } = useSidebarFocusRequestStore.getState();
  if (target === null) return false;
  if (mountedTarget === null) return true;
  useSidebarFocusRequestStore.setState({ target: null });
  mountedTarget.serve(target);
  return true;
}

function isSidebarSearchFocused(): boolean {
  const input = mountedTarget?.searchInput() ?? null;
  return input !== null && input === document.activeElement;
}

// The origin is read and written only here. Inside the component the React
// Compiler took a module variable for a constant: `const origin =
// searchFocusOrigin` read the value after the following `= null`.
function rememberSearchFocusOrigin(revealedSidebar: boolean): void {
  searchFocusOrigin = captureSearchFocusOrigin(revealedSidebar);
}

function takeSearchFocusOrigin(): SearchFocusOrigin | null {
  const origin = searchFocusOrigin;
  searchFocusOrigin = null;
  return origin;
}

function forgetSearchFocusOrigin(): void {
  searchFocusOrigin = null;
}

function captureSearchFocusOrigin(revealedSidebar: boolean): SearchFocusOrigin {
  const element = document.activeElement;
  return {
    element,
    pane: getFocusedPane() ?? getLastFocusedPane(),
    restoreComposer: captureComposerFocusReturn(element),
    revealedSidebar,
  };
}

/**
 * The element the command came from when it is still there, else its pane:
 * the palette's input and a Settings control are gone by now, and Vim's chat
 * buffer holds the keys on <body>, which only `focusPane` can hand back.
 */
function returnFocusToOrigin(origin: SearchFocusOrigin | null): void {
  if (origin?.restoreComposer?.()) return;
  const element = origin?.element;
  if (element instanceof HTMLElement && element !== document.body && element.isConnected) {
    element.focus({ preventScroll: true });
    return;
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (origin) focusPane(origin.pane);
}

function toggleAllProjects(): void {
  const before = useProjectScopeStore.getState().projectScopeKey;
  const after = useProjectScopeStore.getState().toggleAllProjects();
  if (after === before) return;
  // A selection made under one scope can hold threads the next scope hides.
  useThreadSelectionStore.getState().clearSelection();
  toastManager.add({
    id: "project-scope-toggle",
    title: after === null ? "All projects" : (projectScopeLabels.get(after) ?? "Project filter"),
    timeout: 1500,
  });
}

const FOCUS_TARGET_BY_COMMAND = {
  "threadSearch.toggle": "search",
  "projectScope.toggle": "projectFilter",
} as const satisfies Partial<Record<KeybindingCommand, SidebarFocusTarget>>;

const STATE_COMMANDS = ["projectScope.toggleAll", "sidebar.toggleWorking"] as const;

type SidebarCommand = keyof typeof FOCUS_TARGET_BY_COMMAND | (typeof STATE_COMMANDS)[number];

function isSidebarCommand(command: KeybindingCommand | null): command is SidebarCommand {
  return (
    (STATE_COMMANDS as ReadonlyArray<string | null>).includes(command) ||
    (command ?? "") in FOCUS_TARGET_BY_COMMAND
  );
}

/**
 * Mounted once in the app layout, outside the phone drawer, on every page. The `legacy` sidebar
 * has neither a Search field nor a project filter, so both focus commands open the command
 * palette instead; the scope toggle writes the store whatever shows.
 */
export function SidebarCommandHost(props: { readonly surface: "threads" | "settings" | "legacy" }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { isMobile, open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const closeAppModal = useCloseAppModal();

  const sidebarHidden = isMobile ? !openMobile : !open;

  // The Search field's way out: `threadSearch.toggle` again, or Escape on the empty field, hands
  // the keyboard back to where the command took it from and hides a sidebar the command showed.
  const leaveSearch = () => {
    const origin = takeSearchFocusOrigin();
    if (isMobile) {
      // The drawer is modal, so nothing behind it can take focus while it
      // closes, and focusing the composer would raise the software keyboard
      // over the thread the drawer just uncovered. Closing it is the way back.
      (document.activeElement as HTMLElement | null)?.blur?.();
      setOpenMobile(false);
      return;
    }
    // Before hiding: a collapsing sidebar that still holds focus moves it to its trigger.
    returnFocusToOrigin(origin);
    if (origin?.revealedSidebar) setOpen(false);
  };

  const run = (command: SidebarCommand) => {
    if (command === "projectScope.toggleAll") {
      toggleAllProjects();
      return;
    }
    if (command === "sidebar.toggleWorking") {
      // A hidden sidebar opens on its Working section rather than flipping a state nobody sees.
      setWorkingSectionExpanded((expanded) => sidebarHidden || !expanded);
      if (sidebarHidden) (isMobile ? setOpenMobile : setOpen)(true);
      return;
    }
    if (props.surface === "legacy") {
      openCommandPalette();
      return;
    }
    if (command === "threadSearch.toggle") {
      if (isSidebarSearchFocused()) {
        leaveSearch();
        return;
      }
      rememberSearchFocusOrigin(sidebarHidden);
    }
    // The sidebar is workspace too: a focus request over the agent search popup closes it first.
    closeAgentSearchPopupForWorkspace();
    const request = () =>
      useSidebarFocusRequestStore.setState({ target: FOCUS_TARGET_BY_COMMAND[command] });
    if (isCommandPaletteOpen()) window.dispatchEvent(new Event(CLOSE_PALETTE_EVENT));
    // The modal keeps the sidebar inert until its route is gone, so the request waits for that.
    if (props.surface === "settings") void closeAppModal().then(request);
    else request();
    if (sidebarHidden) (isMobile ? setOpenMobile : setOpen)(true);
  };

  useCommandHandlers({
    "threadSearch.toggle": () => run("threadSearch.toggle"),
    "projectScope.toggle": () => run("projectScope.toggle"),
    "projectScope.toggleAll": () => run("projectScope.toggleAll"),
    "sidebar.toggleWorking": () => run("sidebar.toggleWorking"),
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: window keydown and focusout listeners for the sidebar commands and the Search way back, re-bound each render to read the latest run
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Escape on a query clears it (the sidebar's own handler); on the empty field it leaves.
      if (
        event.key === "Escape" &&
        !event.isComposing &&
        isSidebarSearchFocused() &&
        mountedTarget?.searchInput()?.value.trim() === "" &&
        !useAgentSearchPopupStore.getState().open
      ) {
        event.preventDefault();
        event.stopPropagation();
        leaveSearch();
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (!isSidebarCommand(command)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) run(command);
    };
    // Switching windows blurs the field too, and the way back outlives that.
    const onFocusOut = (event: FocusEvent) => {
      if (event.target === mountedTarget?.searchInput() && document.hasFocus()) {
        forgetSearchFocusOrigin();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusout", onFocusOut);
    };
  });

  return null;
}

/**
 * The mounted sidebar's half: serves focus requests with its own Search field
 * and project filter, and keeps the project names the toggle's toast shows.
 * A request made while the command palette is open waits for the palette's
 * final focus, because the palette makes the rest of the page inert.
 */
export function useSidebarCommandTarget(input: {
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly openProjectFilter: () => void;
  readonly projectScopeItems: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}): void {
  const { searchInputRef, openProjectFilter, projectScopeItems } = input;
  const target = useSidebarFocusRequestStore((store) => store.target);

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: publishes the mounted sidebar's project names to the module map the toast reads
  useEffect(() => {
    projectScopeLabels.clear();
    for (const item of projectScopeItems) projectScopeLabels.set(item.value, item.label);
  }, [projectScopeItems]);

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: registers this mounted sidebar as the module-level focus server, removed on unmount
  useEffect(() => {
    const target = {
      serve: (focusTarget: SidebarFocusTarget) => {
        if (focusTarget === "search") searchInputRef.current?.focus();
        else openProjectFilter();
      },
      searchInput: () => searchInputRef.current,
    };
    mountedTarget = target;
    return () => {
      if (mountedTarget === target) mountedTarget = null;
    };
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: serves a focus request from the external store once the sidebar can take focus
  useEffect(() => {
    if (target !== null && !isCommandPaletteOpen()) serveSidebarFocusRequest();
  }, [target]);
}
