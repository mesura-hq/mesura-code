/**
 * Mounts the application entry point for the thread-search picker suites:
 * `AppRoot` with a memory router whose root route renders the real
 * `CommandPalette` around an `Outlet` plus the `ConfirmDialogHost`, the same
 * shell `routes/__root.tsx` builds. The data it renders comes from
 * `threadSearchPicker.testFixtures.ts`, which the suites wire through `vi.mock`.
 *
 * Kept apart from the fixtures on purpose: the mock factories import the
 * fixtures while the application graph is loading, and a fixture module that
 * itself imported `CommandPalette` would deadlock on that circular import.
 */
import type { AgentThreadSearchResult } from "@t3tools/client-runtime/state/agent-thread-search";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { act, type ReactNode } from "react";

/** A route body with no props, as `createRoute` accepts it. */
type RouteComponent = () => ReactNode;
import { createRoot, type Root } from "react-dom/client";
import { expect, vi } from "vite-plus/test";

import { AppRoot } from "../../AppRoot";
import type { AppRouter } from "../../router";
import { CommandPalette } from "../CommandPalette";
import { ConfirmDialogHost } from "../ConfirmDialogHost";

function ThreadRouteProbe() {
  const params = useParams({ strict: false }) as { environmentId?: string; threadId?: string };
  return (
    <div data-testid="thread-route">
      {params.environmentId}/{params.threadId}
    </div>
  );
}

export interface MountedApp {
  readonly container: HTMLDivElement;
  readonly router: ReturnType<typeof createAppRouter>;
  readonly unmount: () => Promise<void>;
}

function DefaultHomeRoute() {
  return <div data-testid="home-route">home</div>;
}

function createAppRouter(HomeRoute: RouteComponent = DefaultHomeRoute) {
  const root = createRootRoute({
    component: () => (
      <>
        <CommandPalette>
          <Outlet />
        </CommandPalette>
        <ConfirmDialogHost />
      </>
    ),
  });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: HomeRoute,
  });
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: ThreadRouteProbe,
  });
  return createRouter({
    routeTree: root.addChildren([index, thread]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

export async function mountApp(
  options: { readonly homeRoute?: RouteComponent } = {},
): Promise<MountedApp> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const router = createAppRouter(options.homeRoute);
  await router.load();
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
  return {
    container,
    router,
    unmount: async () => {
      await act(async () => root?.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

/** Lets pending atom writes, effects, and router transitions settle. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export async function pressKey(
  target: EventTarget,
  key: string,
  modifiers: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
  code?: string,
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await settle();
  return event;
}

export function openThreadSearch(): Promise<KeyboardEvent> {
  return pressKey(window, "k", { ctrlKey: true, altKey: true });
}

export function openFilePicker(): Promise<KeyboardEvent> {
  return pressKey(window, "p", { ctrlKey: true });
}

export function openCommandPalette(): Promise<KeyboardEvent> {
  return pressKey(window, "o", { ctrlKey: true });
}

export function paletteElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="command-palette"]');
}

export function paletteMode(): string | null {
  return paletteElement()?.getAttribute("data-palette-mode") ?? null;
}

const PICKER_SELECTOR = '[data-testid="thread-search-picker"]';

export function threadSearchPicker(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PICKER_SELECTOR);
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * The text field the thread-search picker currently types into, in either
 * mode: the focused one when focus is inside the picker, else the first one.
 */
export function pickerTextField(): TextField {
  const picker = threadSearchPicker();
  expect(
    picker,
    `Expected the thread-search picker; rendered: ${document.body.textContent}`,
  ).not.toBeNull();
  const active = document.activeElement;
  if (
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    picker!.contains(active)
  ) {
    return active;
  }
  const field = picker!.querySelector<TextField>('input:not([type="hidden"]), textarea');
  expect(
    field,
    `Expected a text field in the picker; rendered: ${picker!.textContent}`,
  ).not.toBeNull();
  return field!;
}

export function focusIsInPickerTextField(): boolean {
  const picker = threadSearchPicker();
  const active = document.activeElement;
  return (
    picker !== null &&
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    picker.contains(active)
  );
}

export async function typeInto(field: TextField, value: string): Promise<void> {
  await act(async () => {
    field.focus();
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** Types into the picker's current field and presses Enter there. */
export async function submitDescription(description: string): Promise<void> {
  const field = pickerTextField();
  await typeInto(field, description);
  await pressKey(field, "Enter");
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

export function optionRows(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-testid="command-palette"] [role="option"]'),
  ];
}

export function isHighlighted(row: HTMLElement): boolean {
  return row.hasAttribute("data-highlighted") || row.getAttribute("aria-selected") === "true";
}

export function currentPath(app: MountedApp): string {
  return app.router.state.location.pathname;
}

function accessibleName(element: Element): string {
  return (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
}

/**
 * One segment of the picker's visible mode control: a button, tab, or radio
 * whose accessible name matches. The segment that is on reports it through
 * `aria-pressed`, `aria-checked`, or `aria-selected`.
 */
export function modeControl(name: RegExp): HTMLElement | null {
  const picker = threadSearchPicker();
  if (picker === null) return null;
  return (
    [
      ...picker.querySelectorAll<HTMLElement>(
        'button, [role="tab"], [role="radio"], [role="switch"]',
      ),
    ].find((element) => name.test(accessibleName(element))) ?? null
  );
}

export const AGENT_MODE_NAME = /agent/i;
export const EXACT_MODE_NAME = /exact/i;

function isOn(element: HTMLElement | null): boolean {
  if (element === null) return false;
  return ["aria-pressed", "aria-checked", "aria-selected"].some(
    (attribute) => element.getAttribute(attribute) === "true",
  );
}

/** Which search mode the visible control reports, or null when it reports none. */
export function activeSearchMode(): "agent" | "exact" | null {
  if (isOn(modeControl(AGENT_MODE_NAME))) return "agent";
  if (isOn(modeControl(EXACT_MODE_NAME))) return "exact";
  return null;
}

export function alertDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="alertdialog"]');
}

export function buttonIn(root: ParentNode, name: RegExp): HTMLElement {
  const match = [...root.querySelectorAll<HTMLElement>("button")].find((element) =>
    name.test(accessibleName(element)),
  );
  expect(
    match,
    `Expected a button named ${name}; rendered: ${(root as Element).textContent ?? ""}`,
  ).toBeDefined();
  return match!;
}

export async function resolveAgentSearch(
  call: { readonly deferred: Deferred.Deferred<AgentThreadSearchResult> },
  result: AgentThreadSearchResult,
): Promise<void> {
  await act(async () => {
    Effect.runSync(Deferred.succeed(call.deferred, result));
  });
  await settle();
}
