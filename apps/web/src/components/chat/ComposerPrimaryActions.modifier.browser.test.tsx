import { act, render as renderBrowser, type Screen } from "../../../test/render";
/**
 * Entry point: `ComposerPrimaryActions`, mounted under React in the DOM, with
 * modifiers pressed on `window` as the browser delivers them.
 *
 * Phase 4 of the editor latency cycle ("One key costs one small render"),
 * criterion 2: a Control chord typed in the modal editor re-rendered the
 * composer's actions, because they follow the held modifiers for the queue
 * shortcut. Holding Ctrl or ⌘ only means something while a turn runs: it
 * turns a steer into a queue, or the reverse. Without a running turn the
 * actions do not follow the modifiers at all.
 */
import { Profiler, createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

let root: Screen | undefined;
let container: HTMLDivElement;
let commits = 0;

async function setupBrowserFixture0() {
  container = document.createElement("div");
  document.body.append(container);
  commits = 0;

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

async function mountActions(isRunning: boolean): Promise<void> {
  await act(async () => {
    root ??= await renderBrowser(null, { container: container, router: false });
    await root.rerender(
      createElement(
        Profiler,
        {
          id: "composer-primary-actions",
          onRender: () => {
            commits += 1;
          },
        },
        createElement(ComposerPrimaryActions, {
          compact: true,
          canOperateThread: true,
          pendingAction: null,
          onPreviousPendingQuestion: () => {},
          isRunning,
          canInterrupt: isRunning,
          followUpBehavior: "steer",
          showPlanFollowUpPrompt: false,
          promptHasText: true,
          isSendBusy: false,
          sendDisabledReason: null,
          isConnecting: false,
          isEnvironmentUnavailable: false,
          isPreparingWorktree: false,
          hasSendableContent: true,
          onInterrupt: () => {},
          onImplementPlanInNewThread: () => {},
        }),
      ),
    );
  });
}

const CONTROL = { key: "Control", code: "ControlLeft", ctrlKey: true, bubbles: true };

async function press(type: "keydown" | "keyup", init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent(type, init));
  });
}

const sendLabel = () =>
  [...container.querySelectorAll("button[aria-label]")]
    .map((button) => button.getAttribute("aria-label"))
    .find(
      (label) =>
        label === "Steer message" || label === "Queue message" || label === "Submit message",
    );

describe("the composer's actions and held modifiers", () => {
  it("composer modifier guard: holding Ctrl while a turn runs turns a steer into a queue", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountActions(true);
    expect(sendLabel()).toBe("Steer message");

    await press("keydown", CONTROL);
    expect(sendLabel(), "Ctrl held").toBe("Queue message");

    await press("keyup", { ...CONTROL, ctrlKey: false });
    expect(sendLabel(), "Ctrl released").toBe("Steer message");
  });

  it("composer modifier spec: a Control chord without a running turn re-renders nothing", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountActions(false);
    const before = commits;

    await press("keydown", CONTROL);
    await press("keydown", { key: "d", code: "KeyD", ctrlKey: true, bubbles: true });
    await press("keyup", { key: "d", code: "KeyD", ctrlKey: true, bubbles: true });
    await press("keyup", { ...CONTROL, ctrlKey: false });

    expect(commits - before, "commits for one Control chord").toBe(0);
    expect(sendLabel()).toBe("Submit message");
  });

  it("composer modifier guard: a turn that starts while Ctrl is already held offers the queue at once", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountActions(false);
    await press("keydown", CONTROL);

    // The turn starts with Ctrl still down: no key event arrives in between.
    await mountActions(true);

    expect(sendLabel(), "Ctrl held since before the turn").toBe("Queue message");
    await press("keyup", { ...CONTROL, ctrlKey: false });
    expect(sendLabel(), "Ctrl released").toBe("Steer message");
  });
});
