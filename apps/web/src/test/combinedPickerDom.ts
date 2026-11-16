import { act } from "../../test/render";
import { expect } from "vite-plus/test";

export function pickerContent() {
  return document.querySelector<HTMLElement>("[data-model-picker-content]");
}

export function searchInput() {
  const input = pickerContent()?.querySelector<HTMLInputElement>("input");
  expect(input, "Expected the model picker search input").toBeTruthy();
  return input!;
}

export function rows() {
  return [...(pickerContent()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

export function row(name: string) {
  const match = rows().find((entry) => entry.textContent?.includes(name));
  expect(
    match,
    `Expected model row ${name}; rendered: ${pickerContent()?.textContent}`,
  ).toBeTruthy();
  return match!;
}

export function highlightedRow() {
  return rows().find((entry) => entry.hasAttribute("data-highlighted")) ?? null;
}

/** The upstream model list is a sibling of the fork's effort column and footer. */
export function pickerPopup() {
  const popup = pickerContent()?.closest<HTMLElement>('[data-slot="popover-popup"]');
  expect(popup, "Expected the docked picker popup").toBeTruthy();
  return popup!;
}

export function effortColumn() {
  const column = pickerPopup().querySelector<HTMLElement>("[data-model-picker-effort]");
  expect(column, "Expected the docked reasoning column").toBeTruthy();
  return column!;
}

export function effortLevel(label: string) {
  const level = [...effortColumn().querySelectorAll<HTMLButtonElement>("[data-effort-level]")].find(
    (button) => button.firstElementChild?.textContent?.trim() === label,
  );
  expect(level, `Expected reasoning level ${label}`).toBeTruthy();
  return level!;
}

export function selectedEffort() {
  return (
    effortColumn()
      .querySelector('[data-effort-level][aria-checked="true"]')
      ?.firstElementChild?.textContent?.trim() ?? null
  );
}

export function permissionsTrigger() {
  const trigger = pickerPopup().querySelector<HTMLButtonElement>(
    "[data-composer-permissions-trigger]",
  );
  expect(trigger, "Expected the picker's permissions trigger").toBeTruthy();
  return trigger!;
}

export function buttonByLabel(label: string | RegExp, scope: ParentNode = document) {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
      const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof label === "string" ? name.trim() === label : label.test(name.trim());
    }) ?? null
  );
}

export async function press(
  target: EventTarget,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

export async function click(element: HTMLElement) {
  await act(async () => element.click());
}
