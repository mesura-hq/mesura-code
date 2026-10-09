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
import { useSyncExternalStore } from "react";

import { runRegisteredCommand } from "~/commands/commandRegistry";
import { toastManager } from "~/components/ui/toast";
import { focusPane } from "~/lib/paneFocus";

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

/** The active tab's title button: where focus rests in the panel after a key. */
export const ACTIVE_TAB_TITLE_SELECTOR =
  '[data-right-panel-tabbar] [data-active-tab="true"] button:not([aria-label])';
/** Frames to wait for the panel to render its new active tab after a key. */
export const ACTIVE_TAB_WAIT_FRAMES = 10;

let launcherOpen = false;
const listeners = new Set<() => void>();

function setLauncherOpen(open: boolean): void {
  if (launcherOpen === open) return;
  launcherOpen = open;
  for (const listener of listeners) listener();
}

/** Where focus was when the launcher opened, for `dismissPanelLauncher`. */
let returnFocus: HTMLElement | null = null;

export function openPanelLauncher(): void {
  if (!launcherOpen) {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  setLauncherOpen(true);
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
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
let launcherKeyHandler: ((event: KeyboardEvent) => boolean) | null = null;

export function registerLauncherKeyHandler(handler: (event: KeyboardEvent) => boolean): () => void {
  launcherKeyHandler = handler;
  return () => {
    if (launcherKeyHandler === handler) launcherKeyHandler = null;
  };
}

const LAUNCHER_ROOT_SELECTOR = '[aria-label="Open a surface"]';

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (launcherKeyHandler === null) return;
      const focused = document.activeElement?.closest(LAUNCHER_ROOT_SELECTOR) != null;
      if (!launcherOpen && !focused) return;
      if (launcherKeyHandler(event)) event.stopImmediatePropagation();
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
  const panel = document
    .querySelector(LAUNCHER_ROOT_SELECTOR)
    ?.closest("[data-preview-panel-mode]");
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
 * After a launcher row runs: the launcher that held focus is gone,
 * so focus would fall to <body> and `Ctrl+T` or `Ctrl+Tab` would no longer
 * read as the panel's. A surface that takes focus itself (a terminal, the
 * agents composer) keeps it; otherwise focus goes to the new active tab.
 */
export function keepFocusInPanelAfterRender(panel: Element): void {
  let frames = 0;
  const attempt = () => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    if (!panel.isConnected) return;
    const target = panel.querySelector<HTMLElement>(ACTIVE_TAB_TITLE_SELECTOR);
    if (target !== null) {
      target.focus({ preventScroll: true });
      return;
    }
    if (++frames < ACTIVE_TAB_WAIT_FRAMES) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}
