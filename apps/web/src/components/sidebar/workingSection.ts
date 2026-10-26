/**
 * Mesura: the sidebar's Working section sits directly under Search, as its own block outside the
 * sortable list, so the list below keeps the developer's order and drag-to-reorder. Upstream puts
 * it above Snoozed and orders the list by return time while it is on.
 */
import { Schema } from "effect";

import { getLocalStorageItem, writeLocalStorageValue } from "../../hooks/useLocalStorage";

/** Upstream's key, so each device keeps the choice it made before the section moved. */
export const WORKING_SECTION_EXPANDED_KEY = "t3code:sidebar:working-expanded";

/** One band crossing every this often, while the section is open and on screen. */
export const WORKING_SWEEP_INTERVAL_MS = 4000;

const SECTION_SELECTOR = "[data-working-section]";
const HEADER_SELECTOR = "[data-working-section-header]";
const ROW_SELECTOR = "[data-mesura-thread-key]";

function readWorkingSectionExpanded(): boolean {
  try {
    return getLocalStorageItem(WORKING_SECTION_EXPANDED_KEY, Schema.Boolean) ?? false;
  } catch {
    return false;
  }
}

/**
 * Collapsing unmounts every working row but the open thread's. A focused row that goes would drop
 * focus on the page, so the header takes it first.
 */
function moveFocusOffHiddenRow(): void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return;
  const section = focused.closest<HTMLElement>(SECTION_SELECTOR);
  const row = focused.closest<HTMLElement>(ROW_SELECTOR);
  if (section === null || row === null || row.getAttribute("aria-current") === "page") return;
  section.querySelector<HTMLElement>(HEADER_SELECTOR)?.focus();
}

/**
 * The one way the section opens or closes: its header, `sidebar.toggleWorking` and the Vim key all
 * come here. Written to storage rather than to sidebar state, because the command also runs while
 * the phone's drawer is unmounted.
 */
export function setWorkingSectionExpanded(value: boolean | ((current: boolean) => boolean)): void {
  const next = typeof value === "function" ? value(readWorkingSectionExpanded()) : value;
  if (!next) moveFocusOffHiddenRow();
  writeLocalStorageValue(WORKING_SECTION_EXPANDED_KEY, next, false, Schema.Boolean);
}
