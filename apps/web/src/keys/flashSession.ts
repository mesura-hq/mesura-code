import { assignFlashLabels } from "@mesura/keys/flash";

import { setFlashSnapshot, type FlashLabel } from "./flashStore";
import { paintHighlight } from "./highlights";
import { updateKeyEngineSnapshot } from "./keyEngineStore";

/**
 * One flash jump in progress, on whichever surface started it.
 *
 * The surface supplies the targets for a pattern and what a jump does; this
 * module owns the keys (pattern, labels, Enter, Backspace, Escape), the label
 * overlay, the match highlight and the backdrop. The label rules are
 * flash.nvim's and live in `@mesura/keys/flash`.
 *
 * The look is the file editor's flash.nvim one, shared by every flash in the
 * app through the `--mesura-flash-*` tokens in `mesura.css`: the text around
 * the matches fades and turns italic (`<html data-mesura-flash>`), matches and
 * labels take the accent.
 */

export interface FlashTarget {
  readonly id: string;
  readonly range: Range;
  /** The character after the match, which a label must never be. */
  readonly nextChar: string | undefined;
  /** Distance from the cursor; nearer targets get the earlier labels. */
  readonly distance: number;
}

export interface FlashProvider {
  /** Which surface flashes; styles the backdrop (`<html data-mesura-flash>`). */
  readonly scope: "chat" | "composer";
  /** The text the backdrop fades while flash is active. */
  backdrop(): Range[];
  /** Visible targets for a pattern. Smartcase: an uppercase letter makes it case-sensitive. */
  collect(pattern: string, caseSensitive: boolean): FlashTarget[];
  jump(target: FlashTarget): void;
}

interface FlashState {
  readonly provider: FlashProvider;
  pattern: string;
  targets: FlashTarget[];
  labels: Map<string, string>;
}

let state: FlashState | null = null;

export function isFlashActive(): boolean {
  return state !== null;
}

export function startFlash(provider: FlashProvider): void {
  state = { provider, pattern: "", targets: [], labels: new Map() };
  // The italic is set before any target is measured, so labels are placed on
  // the text as it is drawn during flash.
  document.documentElement.dataset.mesuraFlash = provider.scope;
  paintHighlight("mesura-flash-backdrop", provider.backdrop());
  setFlashSnapshot({ pattern: "", labels: [], active: true });
}

export function stopFlash(): void {
  state = null;
  delete document.documentElement.dataset.mesuraFlash;
  setFlashSnapshot(null);
  paintHighlight("mesura-flash-match", []);
  paintHighlight("mesura-flash-backdrop", []);
}

function refresh(flash: FlashState): void {
  flash.targets =
    flash.pattern.length === 0
      ? []
      : flash.provider.collect(flash.pattern, flash.pattern !== flash.pattern.toLowerCase());
  flash.labels = assignFlashLabels(flash.targets, flash.labels);
  const labels: FlashLabel[] = [];
  for (const target of flash.targets) {
    const label = flash.labels.get(target.id);
    if (!label) continue;
    const rect = target.range.getBoundingClientRect();
    labels.push({ id: target.id, label, left: rect.right, top: rect.top });
  }
  paintHighlight(
    "mesura-flash-match",
    flash.targets.map((target) => target.range),
  );
  setFlashSnapshot({ pattern: flash.pattern, labels, active: true });
}

/** Every key while flash is active comes here. Always consumes the key. */
export function handleFlashKey(token: string): boolean {
  const flash = state;
  if (!flash) return false;
  if (token === "<Esc>") {
    stopFlash();
    return true;
  }
  if (token === "<BS>") {
    // Backspace on an empty pattern leaves, as in the file manager's flash.
    if (flash.pattern.length === 0) {
      stopFlash();
      return true;
    }
    flash.pattern = flash.pattern.slice(0, -1);
    refresh(flash);
    return true;
  }
  if (token === "<CR>") {
    const nearest = flash.targets.toSorted((left, right) => left.distance - right.distance)[0];
    stopFlash();
    if (nearest) flash.provider.jump(nearest);
    return true;
  }
  if (token.length !== 1) return true;
  if (flash.pattern.length > 0) {
    const target = flash.targets.find((candidate) => flash.labels.get(candidate.id) === token);
    if (target) {
      stopFlash();
      flash.provider.jump(target);
      return true;
    }
  }
  flash.pattern += token;
  refresh(flash);
  if (flash.targets.length === 0) {
    updateKeyEngineSnapshot({ notice: `flash: no match for “${flash.pattern}”` });
    stopFlash();
  }
  return true;
}

/** Every occurrence of `pattern` in `text`, smartcase. */
export function findOccurrences(text: string, pattern: string, caseSensitive: boolean): number[] {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const offsets: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    offsets.push(at);
  }
  return offsets;
}
