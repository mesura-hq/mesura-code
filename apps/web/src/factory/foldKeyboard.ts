import type { KeyboardEvent } from "react";

/** Marks a fold's trigger, so the keys below find every heading of a document in order. */
export const FOLD_TRIGGER_ATTRIBUTE = "data-fold-trigger";

const TRIGGER_SELECTOR = `[${FOLD_TRIGGER_ATTRIBUTE}]`;

function isOpen(trigger: HTMLElement): boolean {
  return trigger.hasAttribute("data-panel-open");
}

/** The heading of the fold that holds this one, or null at the top level. */
function parentTrigger(trigger: HTMLElement, root: HTMLElement): HTMLElement | null {
  const ownFold = trigger.parentElement;
  const outerFold = ownFold?.parentElement?.closest<HTMLElement>("[data-fold]");
  if (!outerFold || !root.contains(outerFold)) return null;
  return outerFold.querySelector<HTMLElement>(`:scope > ${TRIGGER_SELECTOR}`);
}

/**
 * Walks a document of folds like a file tree: Up/Down (`k`/`j`) move, Right (`l`)
 * opens then steps in, Left (`h`) closes then steps out, Home/End jump. The container
 * carries `data-key-scope="tree"`, so the Vim key engine leaves these keys to it.
 */
export function onFoldTreeKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const root = event.currentTarget;
  const trigger = (event.target as HTMLElement).closest<HTMLElement>(TRIGGER_SELECTOR);
  if (trigger === null || !root.contains(trigger)) return;
  const triggers = [...root.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR)];
  const index = triggers.indexOf(trigger);
  let next: HTMLElement | null | undefined;
  switch (event.key) {
    case "ArrowDown":
    case "j":
      next = triggers[index + 1];
      break;
    case "ArrowUp":
    case "k":
      next = triggers[index - 1];
      break;
    case "Home":
      next = triggers[0];
      break;
    case "End":
      next = triggers.at(-1);
      break;
    case "ArrowRight":
    case "l":
      if (!isOpen(trigger)) trigger.click();
      else next = triggers[index + 1];
      break;
    case "ArrowLeft":
    case "h":
      if (isOpen(trigger)) trigger.click();
      else next = parentTrigger(trigger, root);
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}
