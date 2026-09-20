import { isBareModifier, matchKey, normaliseKey } from "./keyEvent.ts";
import { bindingsFor } from "./registry.ts";
import type { Binding, KeyContext, KeyEvent, PickerState } from "./types.ts";

/**
 * Matching and dispatch.
 *
 * Separate from the table so the table reads as a table, and so a test can
 * exercise routing decisions without running a single side effect.
 */

/**
 * Keys suppressed inside a file chooser.
 *
 * Clipboard operations do not belong in a picker. `c` is deliberately absent —
 * it opens the harmless copy-path chord — and Ctrl+V is handled separately
 * below because it is the one suppressed key that carries a modifier.
 */
const PICKER_SUPPRESSED_KEYS: readonly string[] = ["y", "x", "p", " ", "t", "[", "]"];

/**
 * Which binding WOULD handle this event, respecting `when()`.
 *
 * A routing decision only: no pre-pass, no `run`, no side effects. Dispatch uses
 * it, and so do the routing tests — which is the point of separating it.
 */
export function matchBinding(event: KeyEvent, ctx: KeyContext): Binding | null {
  for (const binding of bindingsFor(ctx.view)) {
    if (!matchKey(binding, event)) continue;
    if (binding.when && !binding.when(ctx)) continue;
    return binding;
  }
  return null;
}

/**
 * Picker suppression, as a pre-pass rather than as bindings.
 *
 * Returns true when it consumed the event. It runs BEFORE the binding scan, and
 * the cascade must resolve an active chord before calling `dispatch` at all —
 * otherwise a chord ending in a suppressed letter is eaten before the chord
 * resolver ever sees it.
 */
function pickerPrePass(event: KeyEvent, ctx: KeyContext): boolean {
  const key = normaliseKey(event.key);

  if (key === "escape") {
    pickerEscape(ctx);
    return true;
  }

  return !ctx.state.picker.fileOps && isSuppressedNow(key, event, ctx.state.picker);
}

/** Clear the selection first, and only cancel the picker when there is none. */
function pickerEscape(ctx: KeyContext): void {
  const { picker, selectedCount } = ctx.state;
  if (picker.multiple && selectedCount > 0) ctx.actions.clearSelection();
  else ctx.actions.dismiss();
}

function isSuppressedNow(key: string, event: KeyEvent, picker: PickerState): boolean {
  // Ctrl+V is the one suppressed key that carries a modifier, so it is checked
  // apart from the plain list rather than smuggled into it.
  if (key === "v") return event.ctrl;
  if (!PICKER_SUPPRESSED_KEYS.includes(key)) return false;

  // Space stays live under multi-select: marking before confirming is the whole
  // point of a multiple picker. Ctrl+P is the audio toggle, not paste, so only
  // bare `p` is suppressed.
  if (key === " ") return !picker.multiple;
  if (key === "p") return !event.ctrl;
  return true;
}

/**
 * Would the help sheet be lying to advertise this binding right now?
 *
 * The overlay asks so it never shows a key that picker suppression has taken
 * away. The exemptions mirror the pre-pass EXACTLY — otherwise the sheet hides
 * a binding that still works.
 */
export function isSuppressedInPicker(binding: Binding, ctx: KeyContext): boolean {
  const { picker } = ctx.state;
  if (!picker.active || picker.fileOps) return false;

  for (const key of binding.keys) {
    if (key === "v" && binding.mods === "Ctrl") return true;
    if (!PICKER_SUPPRESSED_KEYS.includes(key)) continue;
    if (key === " " && picker.multiple) continue;
    if (key === "p" && binding.mods === "Ctrl") continue;
    return true;
  }
  return false;
}

/**
 * Run whatever this key means, and report whether it was consumed.
 *
 * The phases mirror the original: bare modifier, then the picker pre-pass, then
 * the binding scan. **A binding whose `when()` is false does NOT consume** — the
 * key falls through to the next handler, which is what preserves `n`/`N` when there are no matches.
 */
export function dispatch(event: KeyEvent, ctx: KeyContext): boolean {
  if (isBareModifier(event)) return false;

  if (ctx.state.picker.active && pickerPrePass(event, ctx)) return true;

  const binding = matchBinding(event, ctx);
  if (binding === null) return false;

  binding.run(ctx);
  return true;
}
