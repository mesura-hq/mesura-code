import type { Binding, KeyEvent, Mods } from "./types.ts";

/**
 * Reading a key press.
 *
 * Its own module because both `dispatch` and `chords` need it, and putting it
 * in either one made them import each other.
 */

/**
 * Lowercase a browser key value.
 *
 * `Shift+G` arrives as `"G"`; the binding declares `"g"` plus `mods: "Shift"`,
 * so the modifier requirement is checked once, in one place, instead of being
 * smuggled into the key value.
 */
export function normaliseKey(key: string): string {
  return key.toLowerCase();
}

/** A modifier pressed on its own resolves nothing and consumes nothing. */
export function isBareModifier(event: KeyEvent): boolean {
  return ["shift", "control", "alt", "meta"].includes(normaliseKey(event.key));
}

/**
 * Which declared modifier combination this event is, or `null` for one no
 * binding declares.
 *
 * `null` for Meta and for Ctrl+Alt is deliberate: those belong to the window
 * manager and the desktop, and a file manager that swallowed them would break
 * shortcuts it has no business touching.
 */
export function modsOf(event: KeyEvent): Mods | null {
  if (event.meta) return null;
  if (event.alt) return event.ctrl || event.shift ? null : "Alt";
  if (event.ctrl) return event.shift ? "Ctrl+Shift" : "Ctrl";
  return event.shift ? "Shift" : "";
}

export function matchKey(binding: Binding, event: KeyEvent): boolean {
  if (!binding.keys.includes(normaliseKey(event.key))) return false;
  if (binding.mods === "*") return true;
  if (binding.mods === "Symbol")
    return !event.meta && ((!event.ctrl && !event.alt) || event.altGraph === true);
  return modsOf(event) === binding.mods;
}
