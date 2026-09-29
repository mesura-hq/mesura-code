/**
 * Mounts the mobile application entry points for the agent-thread-search
 * suites, the way `App.tsx` composes them: the app's atom registry, the
 * `ConfirmDialogHost` at the root, and one of
 *
 * - `HomeRouteScreen` on a phone-width window — the Android home header search;
 * - `AdaptiveWorkspaceLayout` on a tablet-width window around
 *   `HomeRouteScreen` — the split layout that renders `ThreadNavigationSidebar`;
 * - `ArchivedThreadsRouteScreen` — the archived-threads route.
 *
 * Suites import `agentThreadSearch.testMocks.tsx` before this module, so the
 * native and data boundaries are mocked by the time the graph loads. Kept apart
 * from the mocks on purpose: the mock factories run while the application graph
 * is loading, and a mocks module that imported these screens would deadlock on
 * that circular import.
 */
import { RegistryContext } from "@effect/atom-react";
import type { AgentThreadSearchResult } from "@t3tools/client-runtime/state/agent-thread-search";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, vi } from "vite-plus/test";

import { ConfirmDialogHost } from "../../components/ConfirmDialogHost";
import { appAtomRegistry } from "../../state/atom-registry";
import { ArchivedThreadsRouteScreen } from "../archive/ArchivedThreadsRouteScreen";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { AdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AgentThreadSearch } from "./AgentThreadSearch";
import { agentSearchFixture, type AgentSearchCall } from "./agentThreadSearch.testMocks";

export interface MountedApp {
  readonly container: HTMLDivElement;
  readonly rerender: () => Promise<void>;
  readonly unmount: () => Promise<void>;
}

async function mount(render: () => ReactNode): Promise<MountedApp> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const renderApp = () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        {render()}
        <ConfirmDialogHost />
      </RegistryContext.Provider>,
    );
  await act(async () => renderApp());
  await settle();
  return {
    container,
    rerender: async () => {
      await act(async () => renderApp());
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

/** Android home on a phone: the header's search field owns thread search. */
export function mountHome(): Promise<MountedApp> {
  agentSearchFixture.window = { width: 412, height: 915, scale: 2, fontScale: 1 };
  return mount(() => <HomeRouteScreen />);
}

/** Tablet split layout: the thread navigation sidebar owns thread search. */
export function mountSidebar(): Promise<MountedApp> {
  agentSearchFixture.window = { width: 1280, height: 800, scale: 2, fontScale: 1 };
  return mount(() => (
    <AdaptiveWorkspaceLayout pathname="/" workspaceRouteKey="home-route">
      <HomeRouteScreen />
    </AdaptiveWorkspaceLayout>
  ));
}

/**
 * The shared agent-search surface alone, for platforms with no visible entry
 * to it: iOS keeps native exact-word search, yet the shared component must
 * still work there. `onOpenThread` receives what a surface would navigate to.
 */
export function mountAgentThreadSearch(props: {
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}): Promise<MountedApp> {
  agentSearchFixture.window = { width: 412, height: 915, scale: 2, fontScale: 1 };
  return mount(() => (
    <AgentThreadSearch
      surface="regression-shared-surface"
      onExit={() => undefined}
      onOpenThread={props.onOpenThread}
    />
  ));
}

export function mountArchivedThreads(): Promise<MountedApp> {
  agentSearchFixture.window = { width: 412, height: 915, scale: 2, fontScale: 1 };
  return mount(() => <ArchivedThreadsRouteScreen />);
}

/** Lets pending atom writes, effects, and command promises settle. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function accessibleName(element: Element): string {
  return (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
}

function describeRendered(root: ParentNode): string {
  return (root as Element).textContent ?? document.body.textContent ?? "";
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Every text field whose accessible name or placeholder matches. */
export function textFields(name: RegExp, root: ParentNode = document.body): TextField[] {
  return [...root.querySelectorAll<TextField>("input, textarea")].filter(
    (field) =>
      !field.closest("[hidden]") &&
      (name.test(field.getAttribute("aria-label") ?? "") ||
        name.test(field.getAttribute("placeholder") ?? "")),
  );
}

export function textField(name: RegExp, root: ParentNode = document.body): TextField {
  const [field] = textFields(name, root);
  expect(
    field,
    `Expected a text field named ${name}; rendered: ${describeRendered(root)}`,
  ).toBeDefined();
  return field!;
}

/** Every visible button or pressable control whose accessible name matches. */
export function controls(name: RegExp, root: ParentNode = document.body): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"]',
    ),
  ].filter((element) => !element.closest("[hidden]") && name.test(accessibleName(element)));
}

export function control(name: RegExp, root: ParentNode = document.body): HTMLElement {
  const [match] = controls(name, root);
  expect(
    match,
    `Expected a control named ${name}; rendered: ${describeRendered(root)}`,
  ).toBeDefined();
  return match!;
}

export async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
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

export async function pressEnter(field: TextField): Promise<void> {
  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await settle();
}

/** Titles of the thread rows the list currently renders, in order. */
export function threadRowTitles(root: ParentNode = document.body): string[] {
  return [...root.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')]
    .filter((row) => !row.closest("[hidden]"))
    .map((row) => row.textContent ?? "");
}

export function threadRow(title: string, root: ParentNode = document.body): HTMLElement {
  const row = [...root.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')].find(
    (candidate) => candidate.textContent === title,
  );
  expect(
    row,
    `Expected a thread row titled ${title}; rendered: ${describeRendered(root)}`,
  ).toBeDefined();
  return row!;
}

export function sidebarElement(): HTMLElement {
  const sidebar = document.querySelector<HTMLElement>('[data-testid="thread-navigation-sidebar"]');
  expect(
    sidebar,
    `Expected the thread navigation sidebar; rendered: ${document.body.textContent}`,
  ).not.toBeNull();
  return sidebar!;
}

export function visibleText(root: ParentNode = document.body): string {
  const clone = (root as Element).cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll("[hidden]")) hidden.remove();
  return clone.textContent ?? "";
}

/** The route and params of every navigation to a thread, in order. */
export function openedThreads(): Array<{
  readonly environmentId: string;
  readonly threadId: string;
}> {
  return agentSearchFixture.navigations
    .filter((navigation) => navigation.name === "Thread")
    .map((navigation) => {
      const params = navigation.params as { environmentId: unknown; threadId: unknown };
      return { environmentId: String(params.environmentId), threadId: String(params.threadId) };
    });
}

export function latestAgentCall(): AgentSearchCall {
  const call = agentSearchFixture.agentCalls.at(-1);
  expect(call, "Expected the agent search to have started").toBeDefined();
  return call!;
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

/* ─── Agent mode ─────────────────────────────────────────────────────── */

/** The visible control that enters agent mode from exact-word search. */
export const AGENT_MODE_NAME = /agent/i;
/** The visible control that returns to exact-word search, when it is separate. */
export const EXACT_MODE_NAME = /exact/i;
/** The agent mode's description field, by accessible name or placeholder. */
export const AGENT_DESCRIPTION_NAME = /describe/i;

export async function enterAgentMode(root: ParentNode): Promise<void> {
  await press(control(AGENT_MODE_NAME, root));
}

/**
 * Returns to exact-word search through the surface's visible mode control: an
 * "Exact words" segment when there is one, else the agent toggle itself.
 */
export async function leaveAgentMode(root: ParentNode): Promise<void> {
  await press(controls(EXACT_MODE_NAME, root)[0] ?? control(AGENT_MODE_NAME, root));
}

export function agentDescriptionField(root: ParentNode): TextField {
  return textField(AGENT_DESCRIPTION_NAME, root);
}

/**
 * Types a description and submits it the way a phone keyboard does, with its
 * return key; a surface that submits through a visible Search or Send button
 * instead is pressed as a fallback.
 */
export async function submitAgentDescription(root: ParentNode, description: string): Promise<void> {
  const field = agentDescriptionField(root);
  const callsBefore = agentSearchFixture.agentCalls.length;
  await typeInto(field, description);
  await pressEnter(field);
  if (agentSearchFixture.agentCalls.length > callsBefore) return;
  const submit = controls(/^(search|send|submit)$/i, root)[0];
  if (submit !== undefined) await press(submit);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Agent result controls, which are never rows of the exact-word thread list. */
export function agentResults(title: string, root: ParentNode = document.body): HTMLElement[] {
  return controls(new RegExp(escapeRegExp(title)), root).filter(
    (element) => element.closest('[data-testid="thread-row"]') === null,
  );
}

export function agentResult(title: string, root: ParentNode = document.body): HTMLElement {
  const [result] = agentResults(title, root);
  expect(
    result,
    `Expected an agent result titled ${title}; rendered: ${visibleText(root)}`,
  ).toBeDefined();
  return result!;
}

/** Everything a result row tells the user: its accessible name and its text. */
export function resultDescription(result: HTMLElement): string {
  return `${result.getAttribute("aria-label") ?? ""} ${result.textContent ?? ""}`;
}

/**
 * What the app is asking or telling the user outside the surface: the root
 * dialog host's open dialog, or the platform alert it raised.
 */
export function promptText(): string {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .map((dialog) => dialog.textContent ?? "")
    .join(" ");
  const alerts = agentSearchFixture.alerts
    .map((alert) => `${alert.title} ${alert.message ?? ""}`)
    .join(" ");
  return `${dialogs} ${alerts}`;
}

/** Presses a button of the open dialog, or of the last platform alert. */
export async function pressPromptButton(name: RegExp): Promise<void> {
  const dialogButton = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"] button, [role="alertdialog"] button',
    ),
  ].find((button) => name.test(accessibleName(button)));
  if (dialogButton !== undefined) {
    await press(dialogButton);
    return;
  }
  const alertButton = agentSearchFixture.alerts
    .at(-1)
    ?.buttons.find((button) => name.test(button.text ?? ""));
  expect(
    alertButton,
    `Expected a prompt button named ${name}; prompt: ${promptText()}`,
  ).toBeDefined();
  await act(async () => {
    alertButton!.onPress?.();
  });
  await settle();
}

/** The surface's visible text plus any prompt, where an error may be reported. */
export function visibleFeedback(root: ParentNode = document.body): string {
  return `${visibleText(root)} ${promptText()}`;
}
