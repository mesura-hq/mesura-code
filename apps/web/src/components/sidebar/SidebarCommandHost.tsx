import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand } from "@t3tools/contracts";
import { type RefObject, useEffect } from "react";
import { create } from "zustand";

import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import { useCommandHandlers } from "../../commands/commandRegistry";
import { resolveShortcutCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { useProjectScopeStore } from "../../projectScopeStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { toastManager } from "../ui/toast";
import { useSidebar } from "../ui/sidebar";
import { useNavigateToMainApp } from "./mainAppLocation";

/**
 * The keyboard's way into the sidebar: `threadSearch.toggle` focuses its Search
 * field, `projectScope.toggle` opens its project filter, and
 * `projectScope.toggleAll` flips that filter between every project and the last.
 *
 * The request is a store, not an event, because the sidebar it targets is not
 * always mounted: at phone width it lives in a drawer whose content unmounts
 * while closed, and on Settings the sidebar shows the settings navigation.
 * `SidebarCommandHost` sits outside both, opens the drawer or returns to the
 * main app, and leaves the request for the sidebar to serve once it mounts.
 * An open command palette is closed first: it makes the rest of the page
 * inert, and its final focus serves the request.
 */
type SidebarFocusTarget = "search" | "projectFilter";

const useSidebarFocusRequestStore = create<{ target: SidebarFocusTarget | null }>()(() => ({
  target: null,
}));

let serveFocusTarget: ((target: SidebarFocusTarget) => void) | null = null;
/** Set when a request leaves Settings for the threads; the chat's next mount focus consumes it. */
let returningFromSettings = false;
/** Display names by project scope key, kept by the mounted sidebar for the toggle's toast. */
const projectScopeLabels = new Map<string, string>();

const CLOSE_PALETTE_EVENT = "mesura:sidebar-request-closes-palette";

/** The command palette listens, so a sidebar request can close it without lifting its state. */
export function onSidebarRequestClosesPalette(listener: () => void): () => void {
  window.addEventListener(CLOSE_PALETTE_EVENT, listener);
  return () => window.removeEventListener(CLOSE_PALETTE_EVENT, listener);
}

/**
 * True once after a focus request left Settings: the chat remounts on the way
 * back and focuses its composer a frame later, after the sidebar has taken the
 * keyboard. The chat's mount focus asks this and skips that one time. Only the
 * return from Settings arms it, so choosing a search result later still hands
 * the keyboard to the composer.
 */
export function sidebarHoldsRequestedFocus(): boolean {
  if (!returningFromSettings) return false;
  returningFromSettings = false;
  return true;
}

/**
 * Serves a pending focus request, when the sidebar is mounted to take it.
 * Returns true while one is pending, so a closing overlay does not hand focus
 * elsewhere first; the command palette's final focus asks this.
 */
export function serveSidebarFocusRequest(): boolean {
  const { target } = useSidebarFocusRequestStore.getState();
  if (target === null) return false;
  if (serveFocusTarget === null) return true;
  useSidebarFocusRequestStore.setState({ target: null });
  serveFocusTarget(target);
  return true;
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

type SidebarCommand = keyof typeof FOCUS_TARGET_BY_COMMAND | "projectScope.toggleAll";

function isSidebarCommand(command: KeybindingCommand | null): command is SidebarCommand {
  return command === "projectScope.toggleAll" || (command ?? "") in FOCUS_TARGET_BY_COMMAND;
}

/**
 * Mounted once in the app layout, outside the phone drawer, on every page.
 *
 * `surface` is what the layout's sidebar slot shows. `legacy` has neither a
 * Search field nor a project filter, so both focus commands open the command
 * palette, whose thread rows search every project. The scope toggle writes the
 * store whatever shows; the legacy sidebar does not read it.
 */
export function SidebarCommandHost(props: { readonly surface: "threads" | "settings" | "legacy" }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { isMobile, open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const navigateToMainApp = useNavigateToMainApp();

  const run = (command: SidebarCommand) => {
    if (command === "projectScope.toggleAll") {
      toggleAllProjects();
      return;
    }
    if (props.surface === "legacy") {
      openCommandPalette();
      return;
    }
    useSidebarFocusRequestStore.setState({ target: FOCUS_TARGET_BY_COMMAND[command] });
    if (isCommandPaletteOpen()) window.dispatchEvent(new Event(CLOSE_PALETTE_EVENT));
    if (props.surface === "settings") {
      returningFromSettings = true;
      void navigateToMainApp();
    }
    if (isMobile ? !openMobile : !open) (isMobile ? setOpenMobile : setOpen)(true);
  };

  useCommandHandlers({
    "threadSearch.toggle": () => run("threadSearch.toggle"),
    "projectScope.toggle": () => run("projectScope.toggle"),
    "projectScope.toggleAll": () => run("projectScope.toggleAll"),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (!isSidebarCommand(command)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) run(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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

  useEffect(() => {
    projectScopeLabels.clear();
    for (const item of projectScopeItems) projectScopeLabels.set(item.value, item.label);
  }, [projectScopeItems]);

  useEffect(() => {
    const serve = (focusTarget: SidebarFocusTarget) => {
      if (focusTarget === "search") searchInputRef.current?.focus();
      else openProjectFilter();
    };
    serveFocusTarget = serve;
    return () => {
      if (serveFocusTarget === serve) serveFocusTarget = null;
    };
  });

  useEffect(() => {
    if (target !== null && !isCommandPaletteOpen()) serveSidebarFocusRequest();
  }, [target]);
}
