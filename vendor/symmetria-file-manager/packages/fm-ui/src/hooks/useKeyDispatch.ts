import { type CascadeMode, handleKey, type KeyOutcome } from "@symmetria/fm-core/keys/cascade";
import { matchBinding } from "@symmetria/fm-core/keys/dispatch";
import type { KeyContext, KeyEvent } from "@symmetria/fm-core/keys/types";
import { useEffect, useRef } from "react";

/**
 * Route every key press through the ported cascade.
 *
 * One listener on the window, because the cascade already decides who owns the
 * keyboard — a per-component handler would put that decision back in the DOM's
 * hands, where precedence is bubbling order rather than anything stated.
 */

/** True when the key landed in a field the user is typing into. */
function targetIsTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

export interface KeyDispatchOptions {
  readonly mode: CascadeMode;
  readonly context: KeyContext;
  /** Called for a key the flash handler owns. */
  onFlashKey?: (event: KeyboardEvent) => boolean;
}

export function useKeyDispatch({ mode, context, onFlashKey }: KeyDispatchOptions): void {
  // The listener is attached once and reads through a ref.
  //
  // Re-attaching on every state change would be correct but wasteful, and it
  // would also drop a key that arrived mid-swap. The ref keeps one listener
  // looking at fresh state.
  const latest = useRef({ mode, context, onFlashKey });
  latest.current = { mode, context, onFlashKey };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const { mode: currentMode, context: ctx, onFlashKey: flash } = latest.current;

      // Focus wins over everything, and it is decided by the DOM rather than by
      // the cascade — which is exactly what the corrected Escape order says.
      const effective: CascadeMode = {
        ...currentMode,
        textInputFocused: currentMode.textInputFocused || targetIsTextInput(event.target),
      };

      const key = {
        key: event.key,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
        altGraph: event.getModifierState("AltGraph"),
      };
      const outcome = routeKey(event, key, effective, ctx, flash);
      // `notOurs` and `unhandled` are the two that must NOT be swallowed: one
      // belongs to a text field, the other to whatever handles it next.
      if (outcome.kind === "notOurs" || outcome.kind === "unhandled") return;

      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function routeKey(
  event: KeyboardEvent,
  key: KeyEvent,
  mode: CascadeMode,
  context: KeyContext,
  flash: KeyDispatchOptions["onFlashKey"],
): KeyOutcome {
  // Tree toolbar controls retain native activation. Otherwise Enter on Include
  // opened the selected file and prevented the focused button's default action.
  if (nativeControlActivation(event, context, mode)) return { kind: "notOurs" };
  if (repeatedFlash(event, key, mode, context)) return { kind: "unhandled" };
  const outcome = handleKey(key, mode, context);
  if (outcome.kind !== "flash" || flash?.(event) !== false) return outcome;
  return handleKey(key, { ...mode, flashActive: false }, context);
}

function nativeControlActivation(event: KeyboardEvent, context: KeyContext, mode: CascadeMode) {
  if (mode.modalOpen || mode.flashActive || mode.chordPrefix) return false;
  if (!isPlainActivation(event)) return false;
  if (!(event.target instanceof Element)) return false;
  const selector =
    context.view === "tree"
      ? "button, summary"
      : ".overview-toolbar button, .overview-toolbar summary";
  return event.target.closest(selector) !== null;
}

function isPlainActivation(event: KeyboardEvent) {
  return (
    ![event.ctrlKey, event.altKey, event.metaKey, event.shiftKey].some(Boolean) &&
    ["Enter", " "].includes(event.key)
  );
}

function repeatedFlash(
  event: KeyboardEvent,
  key: KeyEvent,
  mode: CascadeMode,
  context: KeyContext,
) {
  return (
    event.repeat &&
    !mode.flashActive &&
    ["overview.flash", "flash.enter"].includes(matchBinding(key, context)?.id ?? "")
  );
}
