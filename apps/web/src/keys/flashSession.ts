import { assignFlashLabels, assignJumpLabels } from "@mesura/keys/flash";

import { setFlashSnapshot, type FlashLabel } from "./flashStore";
import { paintHighlight } from "./highlights";
import { observeResize } from "~/lib/observeResize";
import { subscribeComposerLayout } from "./composer/composerExpanded";
import {
  readKeyEngineSnapshot,
  updateKeyEngineSnapshot,
  type EngineModeLabel,
} from "./keyEngineStore";
import { composerEditorElement, hasOpenKeyLayer, resolveKeyScope } from "./focusScope";

/**
 * Two kinds share the overlay and the keys: a search (`s`), where the surface supplies targets per
 * pattern and this module owns the pattern and flash.nvim's label rules; and a pick, where the
 * surface labels every target up front (the chat's cite runs two in a row). The look is shared
 * through the `--mesura-flash-*` tokens in `mesura.css`.
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

export interface FlashPickTarget {
  readonly id: string;
  /** The character the label marks. */
  readonly range: Range;
}

export interface FlashPick {
  readonly scope: "chat" | "composer";
  /** Shown in the flash bar while the labels are up. */
  readonly hint: string;
  /** A label covers its character (`over`) or sits just after it (`after`). */
  readonly placement: "over" | "after";
  readonly backdrop: Range[];
  /** Nearest first: the nearest targets get the one-character labels. */
  readonly targets: readonly FlashPickTarget[];
  /** Ranges painted as matches while the labels are up, such as a chosen start. */
  readonly marked?: readonly Range[];
  pick(target: FlashPickTarget): void;
}

interface FlashState {
  readonly kind: "search";
  readonly provider: FlashProvider;
  pattern: string;
  targets: FlashTarget[];
  labels: Map<string, string>;
}

interface PickState {
  readonly kind: "pick";
  readonly pick: FlashPick;
  readonly labels: ReadonlyMap<string, FlashPickTarget>;
  /** The first character of a two-character label, once typed. */
  typed: string;
}

let state: FlashState | PickState | null = null;
let owner: {
  scope: FlashProvider["scope"];
  element: HTMLElement | null;
  returnMode: EngineModeLabel;
} | null = null;
let disposeLifecycle: (() => void) | null = null;

export function isFlashActive(scope?: string): boolean {
  return state !== null && (scope === undefined || owner?.scope === scope);
}

export function cancelFlashOutsideOwner(target: EventTarget | null): void {
  if (!owner || !(target instanceof Element)) return;
  if (
    target instanceof HTMLIFrameElement ||
    (owner.element !== null && !owner.element.contains(target)) ||
    resolveKeyScope(target) !== owner.scope
  )
    stopFlash();
}

export function cancelFlashOutsideScope(scope: string): void {
  if (state !== null && !isFlashActive(scope)) stopFlash();
}

function ownSession(scope: FlashProvider["scope"]): void {
  disposeLifecycle?.();
  owner = {
    scope,
    returnMode: readKeyEngineSnapshot().mode === "FLASH" ? "NORMAL" : readKeyEngineSnapshot().mode,
    element:
      scope === "composer"
        ? composerEditorElement()
        : document.querySelector<HTMLElement>("[data-chat-column-maximized-away]"),
  };
  const observer = new MutationObserver(() => {
    if (hasOpenKeyLayer() || owner?.element?.isConnected === false) stopFlash();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "role",
      "aria-modal",
      "data-open",
      "data-slot",
      "data-command-palette",
      "data-composer-command-drawer",
    ],
  });
  const elements = [
    ...new Set(
      [
        owner.element,
        document.querySelector<HTMLElement>("[data-assistant-citation-viewport]"),
        composerEditorElement(),
        document.querySelector<HTMLElement>("[data-chat-composer-main-surface]"),
      ].filter((element): element is HTMLElement => element !== null),
    ),
  ];
  const sizes = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
  const unobserveResize = observeResize(elements, (entries) => {
    for (const { target } of entries) {
      const previous = sizes.get(target as HTMLElement);
      const current = target.getBoundingClientRect();
      if (previous && (current.width !== previous.width || current.height !== previous.height)) {
        stopFlash();
        return;
      }
    }
  });
  // Targets are live ranges: content changing under them (streaming, an expanded row) moves the
  // text, so the labels are measured again; a target whose text is gone loses its label.
  let remeasureQueued = false;
  const content = new MutationObserver(() => {
    if (remeasureQueued) return;
    remeasureQueued = true;
    queueMicrotask(() => {
      remeasureQueued = false;
      remeasure();
    });
  });
  if (owner.element) {
    content.observe(owner.element, { childList: true, characterData: true, subtree: true });
  }
  const unsubscribeComposer = subscribeComposerLayout(stopFlash);
  for (const event of ["scroll", "wheel", "resize"]) {
    window.addEventListener(event, stopFlash, { capture: true, passive: true });
  }
  disposeLifecycle = () => {
    observer.disconnect();
    content.disconnect();
    unobserveResize();
    unsubscribeComposer();
    for (const event of ["scroll", "wheel", "resize"]) {
      window.removeEventListener(event, stopFlash, true);
    }
  };
}

export function startFlash(provider: FlashProvider): void {
  stopFlash();
  state = { kind: "search", provider, pattern: "", targets: [], labels: new Map() };
  // The italic is set before any target is measured, so labels are placed on
  // the text as it is drawn during flash.
  document.documentElement.dataset.mesuraFlash = provider.scope;
  ownSession(provider.scope);
  paintHighlight("mesura-flash-backdrop", provider.backdrop());
  setFlashSnapshot({ pattern: "", labels: [], active: true });
}

/**
 * Labels every target of `pick` at once. The caller collects the targets
 * with the flash look already applied (`applyFlashLook`), so they are measured
 * on the text as flash draws it. False, with nothing shown, when there is
 * no target.
 */
export function startFlashPick(pick: FlashPick): boolean {
  if (pick.targets.length === 0) {
    stopFlash();
    return false;
  }
  stopFlash();
  const labels = new Map<string, FlashPickTarget>();
  assignJumpLabels(pick.targets.length).forEach((label, index) => {
    labels.set(label, pick.targets[index]!);
  });
  state = { kind: "pick", pick, labels, typed: "" };
  document.documentElement.dataset.mesuraFlash = pick.scope;
  ownSession(pick.scope);
  paintHighlight("mesura-flash-backdrop", pick.backdrop);
  paintHighlight("mesura-flash-match", pick.marked ?? []);
  refreshPick(state);
  return true;
}

/** Applies the flash look (the italic backdrop) before a pick's targets are measured. */
export function applyFlashLook(scope: "chat" | "composer"): void {
  document.documentElement.dataset.mesuraFlash = scope;
}

/** The labels last shown, so a re-measure that moved nothing renders nothing. */
let shownLabels = "";

function showFlash(snapshot: Parameters<typeof setFlashSnapshot>[0]): void {
  const key = JSON.stringify(snapshot);
  if (key === shownLabels) return;
  shownLabels = key;
  setFlashSnapshot(snapshot);
}

export function stopFlash(): void {
  disposeLifecycle?.();
  disposeLifecycle = null;
  if (owner && readKeyEngineSnapshot().mode === "FLASH") {
    updateKeyEngineSnapshot({ mode: owner.returnMode });
  }
  owner = null;
  state = null;
  delete document.documentElement.dataset.mesuraFlash;
  shownLabels = "";
  setFlashSnapshot(null);
  paintHighlight("mesura-flash-match", []);
  paintHighlight("mesura-flash-backdrop", []);
}

function labelRect(range: Range, placement: FlashPick["placement"]): DOMRect | undefined {
  const fragments = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  return placement === "over" ? fragments[0] : fragments.at(-1);
}

function refresh(flash: FlashState): void {
  flash.targets =
    flash.pattern.length === 0
      ? []
      : flash.provider.collect(flash.pattern, flash.pattern !== flash.pattern.toLowerCase());
  flash.labels = assignFlashLabels(flash.targets, flash.labels);
  renderSearch(flash);
}

/** Places the current labels on their targets as the text lies now. */
function remeasure(): void {
  if (state?.kind === "search") {
    state.targets = state.targets.filter((target) => !target.range.collapsed);
    renderSearch(state);
  } else if (state?.kind === "pick") {
    refreshPick(state);
  }
}

function renderSearch(flash: FlashState): void {
  const labels: FlashLabel[] = [];
  for (const target of flash.targets) {
    const label = flash.labels.get(target.id);
    if (!label) continue;
    const rect = labelRect(target.range, "after");
    if (!rect) continue;
    labels.push({ id: target.id, label, left: rect.right, top: rect.top });
  }
  paintHighlight(
    "mesura-flash-match",
    flash.targets.map((target) => target.range),
  );
  showFlash({
    pattern: flash.pattern,
    labels,
    active: true,
    ...(flash.pattern.length > 0 && flash.targets.length === 0
      ? { hint: `flash: no match for “${flash.pattern}”` }
      : {}),
  });
}

function refreshPick(pick: PickState): void {
  const labels: FlashLabel[] = [];
  for (const [label, target] of pick.labels) {
    if (!label.startsWith(pick.typed)) continue;
    const rect = labelRect(target.range, pick.pick.placement);
    if (!rect) continue;
    labels.push({
      id: target.id,
      label: label.slice(pick.typed.length),
      left: pick.pick.placement === "over" ? rect.left : rect.right,
      top: rect.top,
    });
  }
  showFlash({ pattern: pick.typed, labels, active: true, hint: pick.pick.hint });
}

function handlePickKey(pick: PickState, token: string): boolean {
  if (token === "<Esc>") {
    stopFlash();
    return true;
  }
  if (token === "<BS>") {
    if (pick.typed.length === 0) stopFlash();
    else {
      pick.typed = "";
      refreshPick(pick);
    }
    return true;
  }
  if (token.length !== 1) return true;
  const typed = pick.typed + token;
  const target = pick.labels.get(typed);
  if (target) {
    stopFlash();
    pick.pick.pick(target);
    return true;
  }
  if ([...pick.labels.keys()].some((label) => label.startsWith(typed))) {
    pick.typed = typed;
    refreshPick(pick);
  }
  return true;
}

/** Every key while flash is active comes here. Always consumes the key. */
export function handleFlashKey(token: string): boolean {
  const flash = state;
  if (!flash) return false;
  if (flash.kind === "pick") return handlePickKey(flash, token);
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
