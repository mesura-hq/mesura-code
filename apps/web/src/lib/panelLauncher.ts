import type { KeybindingCommand } from "@t3tools/contracts";
import {
  Columns3,
  EyeOff,
  FolderTree,
  Maximize2,
  Minimize2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";

import { runRegisteredCommand } from "~/commands/commandRegistry";
import { toastManager } from "~/components/ui/toast";
import { focusPane } from "~/lib/paneFocus";
import { ACTIVE_TAB_TITLE_SELECTOR, focusPanelSurfaceAfterRender } from "~/lib/panelSurfaceFocus";

/**
 * The right panel's launcher ("Open a surface") as the panel's one menu.
 *
 * With no tab open the launcher is the panel's empty state. With tabs open,
 * `rightPanel.newTab` (`Space p`, `Ctrl+T` in the panel, the tab bar's `+`)
 * shows the same launcher over the panel's content, so the surfaces stay
 * mounted under it. Its letters open a surface or run a panel action, and a
 * letter that is not available says why instead of doing nothing: this is a
 * keyboard-first app, so a reason must never need a hover.
 */

/** Overlays that must win over the launcher's letter shortcuts. */
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  // Fork addition: the file manager over the window (`MesuraFileManagerLayer`).
  "[data-mesura-file-manager]",
].join(",");

/** Keyboard launchers defer to closed panels, blocking overlays and another panel's launcher. */
export function isPanelLauncherKeyboardAvailable(
  panelOpen: boolean,
  panel?: Element | null,
): boolean {
  return (
    panelOpen &&
    (!panel || !launcherOpen || launcherOwner === null || launcherOwner === panel) &&
    document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS) === null
  );
}

let launcherOpen = false;
let launcherOwner: Element | null = null;
const panels = new Map<Element, boolean>();
const listeners = new Set<() => void>();

function subscribeToPanelLauncher(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setLauncherOpen(open: boolean, owner: Element | null = null): void {
  if (launcherOpen === open && launcherOwner === owner) return;
  launcherOpen = open;
  launcherOwner = owner;
  for (const listener of listeners) listener();
}

function panelRoot(ref: RefObject<HTMLElement | null>): Element | null {
  return ref.current?.closest("[data-preview-panel-mode]") ?? null;
}

/** Registers the panel's lifetime, including its retained closing content. */
export function usePanelLauncherOwner(
  ref: RefObject<HTMLElement | null>,
  panelOpen: boolean,
): boolean {
  useLayoutEffect(() => {
    const panel = panelRoot(ref);
    if (panel === null) return;
    panels.set(panel, panelOpen);
    if (!panelOpen && launcherOwner === panel) closePanelLauncher();
    else if (panelOpen && launcherOpen && (launcherOwner === null || !launcherOwner.isConnected)) {
      setLauncherOpen(true, panel);
    }
    return () => {
      panels.delete(panel);
      // ChatView replaces the inline panel with the phone sheet in one commit.
      // An open replacement can claim the launcher before disposal; an existing
      // unrelated panel does not claim it just because the owner disappeared.
      queueMicrotask(() => {
        if (launcherOwner === panel && !panels.has(panel)) closePanelLauncher();
      });
    };
  }, [ref, panelOpen]);
  return useSyncExternalStore(
    subscribeToPanelLauncher,
    () => launcherOpen && launcherOwner === panelRoot(ref),
    () => false,
  );
}

function focusedOrLatestOpenPanel(): Element | null {
  let latest: Element | null = null;
  for (const [panel, open] of panels) {
    if (!open) continue;
    if (panel.contains(document.activeElement)) return panel;
    latest = panel;
  }
  return latest;
}

/** Where focus was when the launcher opened, for `dismissPanelLauncher`. */
let returnFocus: HTMLElement | null = null;

export function openPanelLauncher(panel?: Element | null): void {
  if (panel && panels.get(panel) === false) return;
  const owner = panel ?? focusedOrLatestOpenPanel();
  if (!launcherOpen || launcherOwner !== owner) {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  setLauncherOpen(true, owner);
}

/** Closes the launcher because a row ran; that row decides where focus goes. */
export function closePanelLauncher(): void {
  returnFocus = null;
  setLauncherOpen(false);
}

/** Closes the launcher with nothing chosen (Escape): focus goes back where it was. */
export function dismissPanelLauncher(): void {
  const target = returnFocus;
  closePanelLauncher();
  if (target?.isConnected) target.focus({ preventScroll: true });
}

export function usePanelLauncherOpen(): boolean {
  return useSyncExternalStore(
    subscribeToPanelLauncher,
    () => launcherOpen,
    () => false,
  );
}

/**
 * The mounted launcher's key handler; true when it took the key.
 *
 * The launcher component also listens on its own, which is how its letters
 * work from anywhere while it is the empty panel. That listener is added when
 * the launcher mounts, after every surface already listening on the window,
 * and a surface such as Diff stops keys it uses before it. So while the
 * launcher is open over the tabs or holds focus, this module's listener,
 * added once when the module loads and therefore ahead of every surface,
 * answers first.
 */
// Like commandRegistry, keep each registration so disposal restores the previous owner.
const launcherKeyHandlers: Array<(event: KeyboardEvent) => boolean> = [];

export function registerLauncherKeyHandler(handler: (event: KeyboardEvent) => boolean): () => void {
  const entry = (event: KeyboardEvent) => handler(event);
  launcherKeyHandlers.push(entry);
  return () => {
    const index = launcherKeyHandlers.lastIndexOf(entry);
    if (index !== -1) launcherKeyHandlers.splice(index, 1);
  };
}

const LAUNCHER_ROOT_SELECTOR = '[aria-label="Open a surface"]';

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (launcherKeyHandlers.length === 0) return;
      const focused = document.activeElement?.closest(LAUNCHER_ROOT_SELECTOR) != null;
      if (!launcherOpen && !focused) return;
      for (let index = launcherKeyHandlers.length - 1; index >= 0; index--) {
        if (launcherKeyHandlers[index]?.(event)) {
          event.stopImmediatePropagation();
          return;
        }
      }
    },
    true,
  );
}

/** Says why a launcher row cannot run, where the keys are, without a hover. */
export function reportUnavailable(label: string, reason: string): void {
  toastManager.add({ type: "info", title: `${label} is not available`, description: reason });
}

/** A panel action in the launcher's second section: a command its owner registered. */
export interface PanelLauncherAction {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
  readonly command: KeybindingCommand;
  /** Shown under the row, and in the notice, when the action cannot run here. */
  readonly unavailableReason: string | null;
}

export function panelLauncherActions(input: {
  readonly hasActiveTab: boolean;
  readonly maximized: boolean;
}): PanelLauncherAction[] {
  return [
    {
      label: input.maximized ? "Restore panel" : "Maximize panel",
      icon: input.maximized ? Minimize2 : Maximize2,
      shortcut: "Z",
      command: "rightPanel.toggleMaximized",
      unavailableReason: input.hasActiveTab ? null : "Open a surface first.",
    },
    {
      label: "Close tab",
      icon: X,
      shortcut: "X",
      command: "rightPanel.close",
      unavailableReason: input.hasActiveTab ? null : "No tab is open.",
    },
    {
      label: "Hide panel",
      icon: EyeOff,
      shortcut: "O",
      command: "rightPanel.toggle",
      unavailableReason: null,
    },
    {
      label: "File tree",
      icon: FolderTree,
      shortcut: "E",
      command: "fileTree.toggle",
      unavailableReason: null,
    },
    {
      label: "File manager",
      icon: Columns3,
      shortcut: "C",
      command: "fileTree.miller",
      unavailableReason: null,
    },
  ];
}

/** Runs a panel action through its owner; an action with no owner here says so. */
export function runPanelLauncherAction(action: PanelLauncherAction): void {
  const panel =
    launcherOwner ??
    document.querySelector(LAUNCHER_ROOT_SELECTOR)?.closest("[data-preview-panel-mode]");
  closePanelLauncher();
  // Hiding the panel hands the keys to the chat; anything else keeps them in
  // the panel. The panel animates closed, so its box cannot tell which.
  if (action.command === "rightPanel.toggle") focusPane("chat");
  else if (panel) keepFocusInPanelAfterRender(panel);
  if (action.unavailableReason !== null) {
    reportUnavailable(action.label, action.unavailableReason);
    return;
  }
  if (!runRegisteredCommand(action.command)) {
    reportUnavailable(action.label, "Nothing on this page handles it.");
  }
}

/**
 * After a launcher row runs: the launcher that held focus is gone, so focus
 * would fall to <body>. It goes into the surface the row opened, or stays in
 * the one under the launcher when the row ran a panel action
 * (`panelSurfaceFocus.ts`).
 */
export function keepFocusInPanelAfterRender(panel: Element): void {
  focusPanelSurfaceAfterRender(panel, panel.querySelector(ACTIVE_TAB_TITLE_SELECTOR));
}
