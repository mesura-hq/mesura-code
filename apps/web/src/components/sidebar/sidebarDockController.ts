/**
 * Mesura: the controller behind the sidebar's two docks, usage (Alt+U) and
 * hosts (Alt+S). Each dock opens while its chord is held, while a mouse or pen
 * rests on its footer icon or the dock, or while it is pinned. A phone has no
 * hover: a long press on the icon pins the dock, and a touch anywhere outside
 * the dock and its icon unpins it.
 *
 * Only one dock is open at a time. Whichever opened last owns
 * `activeSidebarDockAtom`, and a dock that sees another take it closes itself
 * outright — it drops its hover, its held chord and its pin — so nothing
 * reopens on its own when the other one closes.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useSidebar } from "../ui/sidebar";
import {
  closeHeldUsagePeek,
  createUsagePeekHoverBridge,
  createUsagePeekKeyboardLifecycle,
  INITIAL_USAGE_PEEK_STATE,
  isKeybindingCaptureTarget,
  type SidebarPeekCommand,
  type UsagePeekHoverBridge,
  type UsagePeekKeyboardEvent,
  type UsagePeekKeyboardLifecycle,
  type UsagePeekState,
} from "./AccountLimitsPanel.logic";
import { createTouchLongPress, type TouchLongPressHandlers } from "./touchLongPress";

export type SidebarDockId = "usage" | "hosts";

const HOVER_BRIDGE_DELAY_MS = 120;

const activeSidebarDockAtom = Atom.make<SidebarDockId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("sidebar-dock:active"),
);
const pinnedSidebarDockAtom = Atom.make<SidebarDockId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("sidebar-dock:pinned"),
);

/** A dock asked for from outside the sidebar, until its controller can show it. */
const sidebarDockRequestAtom = Atom.make<SidebarDockId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("sidebar-dock:request"),
);

/**
 * Shows a dock pinned, from outside the sidebar: the command palette's "Show
 * hosts". The palette renders outside `SidebarProvider` and cannot reach the
 * sidebar, so it only files the request; the dock's controller carries it out
 * wherever the palette was opened (see `useSidebarDockRequest`).
 */
export function requestSidebarDockPin(dock: SidebarDockId): void {
  appAtomRegistry.set(sidebarDockRequestAtom, dock);
}

/**
 * Carries out a palette request for this dock. The dock exists only on the
 * thread list with a wide viewport, so the controller first leaves a Settings,
 * Usage or pull-requests page for the thread list, expands a collapsed
 * sidebar, and pins only once the dock can show. A mobile-width viewport never
 * has the dock; the palette does not offer the entry there, and a request that
 * arrives anyway is dropped rather than held.
 */
function useSidebarDockRequest(dock: SidebarDockId, enabled: boolean): void {
  const request = useAtomValue(sidebarDockRequestAtom);
  const { isMobile, open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const navigate = useNavigate();
  useEffect(() => {
    if (request !== dock) return;
    if (isMobile) {
      appAtomRegistry.set(sidebarDockRequestAtom, null);
      return;
    }
    if (!sidebarOpen) setSidebarOpen(true);
    if (!enabled) {
      void navigate({ to: "/" });
      return;
    }
    appAtomRegistry.set(sidebarDockRequestAtom, null);
    appAtomRegistry.set(pinnedSidebarDockAtom, dock);
    appAtomRegistry.set(activeSidebarDockAtom, dock);
  }, [dock, enabled, isMobile, navigate, request, setSidebarOpen, sidebarOpen]);
}

interface PointerTypeEvent {
  readonly pointerType: string;
}

/** Spread on the dock and on its footer icon: both count as "on the dock". */
export interface SidebarDockSurfaceProps {
  readonly "data-sidebar-dock-surface": SidebarDockId;
  readonly onPointerEnter: (event: PointerTypeEvent) => void;
  readonly onPointerLeave: (event: PointerTypeEvent) => void;
}

export type SidebarDockTriggerProps = SidebarDockSurfaceProps &
  Omit<TouchLongPressHandlers, "dispose">;

export interface SidebarDockController {
  readonly open: boolean;
  readonly pinned: boolean;
  readonly shortcutLabel: string | null;
  readonly surfaceProps: SidebarDockSurfaceProps;
  readonly triggerProps: SidebarDockTriggerProps;
  /** Pins the dock, or unpins and closes it. */
  readonly togglePinned: () => void;
  readonly close: () => void;
}

function consumeKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

export function useSidebarDockController(input: {
  readonly dock: SidebarDockId;
  readonly command: SidebarPeekCommand;
  readonly enabled: boolean;
}): SidebarDockController {
  const { command, dock, enabled } = input;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const activeDock = useAtomValue(activeSidebarDockAtom);
  const pinned = useAtomValue(pinnedSidebarDockAtom) === dock;
  const [hovered, setHovered] = useState(false);
  const [peek, setPeek] = useState<UsagePeekState>(INITIAL_USAGE_PEEK_STATE);
  const keyboardLifecycleRef = useRef<UsagePeekKeyboardLifecycle | null>(null);
  const hoverBridgeRef = useRef<UsagePeekHoverBridge | null>(null);
  if (hoverBridgeRef.current === null) {
    hoverBridgeRef.current = createUsagePeekHoverBridge({
      delayMs: HOVER_BRIDGE_DELAY_MS,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onHoverChange: setHovered,
    });
  }

  // A finger fires pointerenter and pointerleave around every tap; treated as
  // hover, each tap would flash the dock open for the bridge's 120 ms.
  const onPointerEnter = useCallback((event: PointerTypeEvent) => {
    if (event.pointerType !== "touch") hoverBridgeRef.current?.enter();
  }, []);
  const onPointerLeave = useCallback((event: PointerTypeEvent) => {
    if (event.pointerType !== "touch") hoverBridgeRef.current?.leave();
  }, []);
  const closePanel = useCallback(() => {
    hoverBridgeRef.current?.dispose();
    if (keyboardLifecycleRef.current) {
      keyboardLifecycleRef.current.close();
    } else {
      setPeek(closeHeldUsagePeek());
    }
    if (appAtomRegistry.get(pinnedSidebarDockAtom) === dock) {
      appAtomRegistry.set(pinnedSidebarDockAtom, null);
    }
  }, [dock]);
  const togglePinned = useCallback(() => {
    if (appAtomRegistry.get(pinnedSidebarDockAtom) === dock) {
      closePanel();
      return;
    }
    appAtomRegistry.set(pinnedSidebarDockAtom, dock);
  }, [closePanel, dock]);
  // One long-press tracker per dock for the component's life; a controller's
  // dock id never changes. No `enabled` gate: the footer icons render only
  // where the docks are enabled, and a pin on a disabled dock is dropped below.
  const [longPress] = useState(() =>
    createTouchLongPress({
      onLongPress: () => appAtomRegistry.set(pinnedSidebarDockAtom, dock),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      vibrate: (durationMs) => navigator.vibrate?.(durationMs),
    }),
  );

  useEffect(() => {
    if (!enabled) return;
    const platform = navigator.platform;
    const lifecycle = createUsagePeekKeyboardLifecycle({
      command,
      keybindings,
      platform,
      getContext: () => ({ terminalFocus: isTerminalFocused() }),
      onStateChange: setPeek,
    });
    keyboardLifecycleRef.current = lifecycle;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isKeybindingCaptureTarget(event.target)) return;
      // The popover dismissed itself on Escape and on an outside press. A plain
      // div does neither, and a hover-opened panel can outlive the pointer that
      // opened it — Alt+Tab away mid-hover and no `pointerleave` ever arrives.
      // Escape is the way out, and it unpins a pinned dock too. It is never
      // consumed: the panel may not be open, and whatever else Escape closes
      // has to keep closing.
      if (event.key === "Escape") {
        closePanel();
        return;
      }
      const transition = lifecycle.keyDown(event as UsagePeekKeyboardEvent);
      if (transition.handled) consumeKeyboardEvent(event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const transition = lifecycle.keyUp(event as UsagePeekKeyboardEvent);
      if (transition.handled) consumeKeyboardEvent(event);
    };
    const onVisibilityChange = () => {
      lifecycle.visibilityChange(document.visibilityState === "visible");
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", lifecycle.close);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", lifecycle.close);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      lifecycle.dispose();
      if (keyboardLifecycleRef.current === lifecycle) keyboardLifecycleRef.current = null;
    };
  }, [closePanel, command, enabled, keybindings]);

  // The pin and the active dock live in module-level atoms that outlive any one
  // sidebar. A dock that unmounts gives up both, so the next sidebar starts
  // closed instead of inheriting a pin nobody saw set.
  useEffect(
    () => () => {
      hoverBridgeRef.current?.dispose();
      longPress.dispose();
      if (appAtomRegistry.get(pinnedSidebarDockAtom) === dock) {
        appAtomRegistry.set(pinnedSidebarDockAtom, null);
      }
      if (appAtomRegistry.get(activeSidebarDockAtom) === dock) {
        appAtomRegistry.set(activeSidebarDockAtom, null);
      }
    },
    [dock, longPress],
  );

  useSidebarDockRequest(dock, enabled);

  // A pinned dock on a phone has no pointer to leave it and no Escape key: a
  // touch outside the dock and its icon is the way out. Mouse clicks keep the
  // desktop behaviour, where only the icon, Escape or the other dock unpin.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`[data-sidebar-dock-surface="${dock}"]`)) return;
      closePanel();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closePanel, dock, pinned]);

  // A pin only means something where the dock can show. Leaving for a page
  // without it drops the pin, so the dock does not greet the user on return.
  useEffect(() => {
    if (!enabled && pinned) appAtomRegistry.set(pinnedSidebarDockAtom, null);
  }, [enabled, pinned]);

  const wantsOpen = enabled && (hovered || peek.held || pinned);
  const wantsOpenRef = useRef(wantsOpen);
  // Layout effects, so the dock that opens and the dock that yields change in
  // the same frame instead of one frame apart. They run in this order: the
  // ref is current before the effect below reads it.
  useLayoutEffect(() => {
    wantsOpenRef.current = wantsOpen;
  });
  useLayoutEffect(() => {
    if (wantsOpen) appAtomRegistry.set(activeSidebarDockAtom, dock);
  }, [dock, wantsOpen]);
  // Keyed on the active dock alone: this runs when another dock takes over,
  // not when this one starts wanting to open while the atom still names the
  // other.
  useLayoutEffect(() => {
    if (activeDock !== null && activeDock !== dock && wantsOpenRef.current) closePanel();
  }, [activeDock, closePanel, dock]);

  const surfaceProps = useMemo<SidebarDockSurfaceProps>(
    () => ({ "data-sidebar-dock-surface": dock, onPointerEnter, onPointerLeave }),
    [dock, onPointerEnter, onPointerLeave],
  );
  const triggerProps = useMemo<SidebarDockTriggerProps>(() => {
    const { dispose: _dispose, ...handlers } = longPress;
    return { ...surfaceProps, ...handlers };
  }, [longPress, surfaceProps]);

  return {
    open: wantsOpen && activeDock === dock,
    pinned,
    shortcutLabel: shortcutLabelForCommand(keybindings, command),
    surfaceProps,
    triggerProps,
    togglePinned,
    close: closePanel,
  };
}
