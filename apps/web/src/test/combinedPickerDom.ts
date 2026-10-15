import { act } from "react";
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

export function effortValue(name: string) {
  return (
    row(name).querySelector("[data-combined-picker-effort-value]")?.textContent?.trim() ?? null
  );
}

export function buttonByLabel(label: string | RegExp, scope: ParentNode = document) {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
      const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof label === "string" ? name.trim() === label : label.test(name.trim());
    }) ?? null
  );
}

export function moreOptionsToggle() {
  return buttonByLabel(/^(More options|Back to models)/, pickerContent() ?? document);
}

export function extrasRegion() {
  const controls = moreOptionsToggle()?.getAttribute("aria-controls");
  return controls ? document.getElementById(controls) : null;
}

export function accessSummary() {
  return moreOptionsToggle()?.textContent ?? "";
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

export async function openMoreOptions() {
  const toggle = moreOptionsToggle();
  expect(toggle, "Expected one More options disclosure in the picker").toBeTruthy();
  if (toggle!.getAttribute("aria-expanded") !== "true") await click(toggle!);
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");
}
