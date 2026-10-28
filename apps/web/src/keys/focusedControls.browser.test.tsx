import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { InlinePendingUserInputCard } from "~/components/chat/InlinePendingUserInputCard";
import { TimelineMinimap } from "~/components/chat/TimelineMinimap";
import type { PendingUserInput } from "~/session-logic";
import { registerPaneEntry } from "~/lib/paneFocus";
import { usePaneEdge } from "~/lib/paneEdges";
import { createWindowListenerFixture } from "~/test/keyBrowserFixtures";
import { chatSurface } from "./chat/chatSurface";
import { resolveKeyScope } from "./focusScope";
import { configureKeyEngine, installKeyEngine, registerKeySurface } from "./keyEngine";
import { readKeyEngineSnapshot } from "./keyEngineStore";

function ChatBufferFixture() {
  return (
    <div data-assistant-citation-viewport>
      <div data-timeline-row-id="control-row">
        <p data-assistant-citation-source>Alpha beta gamma</p>
      </div>
    </div>
  );
}

const listeners = createWindowListenerFixture(installKeyEngine);

function engine() {
  using stack = new DisposableStack();
  stack.use(listeners());
  stack.defer(registerKeySurface(chatSurface));
  stack.defer(
    registerPaneEntry("chat", () => {
      (document.activeElement as HTMLElement | null)?.blur();
      chatSurface.reset();
      return true;
    }),
  );
  configureKeyEngine({ enabled: true });
  stack.defer(() => configureKeyEngine({ enabled: false }));
  return stack.move();
}

it("gives real question options their numbers and arrows, then Escape returns to chat", async () => {
  const request: PendingUserInput = {
    requestId: RuntimeRequestId.make("key-control-question"),
    createdAt: "2026-10-28T00:00:00.000Z",
    dismissible: true,
    responseCapability: "message",
    questions: [
      {
        id: "pick",
        header: "Pick",
        question: "Pick an option",
        multiSelect: false,
        options: Array.from({ length: 9 }, (_, index) => ({
          label: `Option ${index + 1}`,
          description: "",
        })),
      },
    ],
  };
  await using screen = await render(
    <div data-chat-column-maximized-away="false">
      <ChatBufferFixture />
      <InlinePendingUserInputCard
        request={request}
        context={{
          environmentId: EnvironmentId.make("key-control-environment"),
          threadId: ThreadId.make("key-control-thread"),
          requests: [request],
          supportsAttachments: false,
          maxFileBytes: null,
          unavailable: false,
          respondingRequestIds: [],
          onRespond: async () => false,
          onDismiss: async () => false,
          onDismissWithAnswer: async () => false,
        }}
      />
    </div>,
  );
  using _engine = engine();
  const option = screen.getByRole("button", { name: /Option 1/ });
  await option.click();
  await userEvent.keyboard("2");
  await expect
    .element(screen.getByRole("button", { name: /Option 2/ }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("9");
  await expect
    .element(screen.getByRole("button", { name: /Option 9/ }))
    .toHaveAttribute("aria-pressed", "true");
  const arrows: string[] = [];
  const receive = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key.startsWith("Arrow")) arrows.push(event.key);
  };
  const element = option.element();
  element.addEventListener("keydown", receive);
  using _listener = { [Symbol.dispose]: () => element.removeEventListener("keydown", receive) };
  await userEvent.keyboard("{ArrowDown}{ArrowUp}");
  expect(arrows).toEqual(["ArrowDown", "ArrowUp"]);
  expect(readKeyEngineSnapshot().pending).toEqual([]);
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(document.body);
  expect(resolveKeyScope()).toBe("chat");
  expect(readKeyEngineSnapshot().mode).toBe("NORMAL");
  await screen.getByRole("textbox", { name: "Pick an option" }).click();
  expect(resolveKeyScope()).toBe("insert");
  await userEvent.keyboard("j");
  await expect.element(screen.getByRole("textbox")).toHaveValue("j");
});

it("gives the real minimap arrows, Home, End, Enter and Space without a leader", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: `turn-${index}`,
    rowIndex: index,
    userText: `Message ${index}`,
    assistantText: null,
  }));
  const onSelect = vi.fn();
  await using screen = await render(
    <div data-chat-column-maximized-away="false" style={{ height: 400 }}>
      <ChatBufferFixture />
      <TimelineMinimap
        hasPersistentGutter
        hitStripWidth={40}
        currentIndex={0}
        items={items}
        stripMap={new Map()}
        onWheel={() => {}}
        onSelect={onSelect}
      />
    </div>,
  );
  using _engine = engine();
  const strip = screen.getByRole("button", { name: /Jump to message/ }).element() as HTMLElement;
  await act(() => strip.focus());
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onSelect).toHaveBeenLastCalledWith(items[1]);
  await userEvent.keyboard("{End}{ArrowUp} ");
  expect(onSelect).toHaveBeenLastCalledWith(items[3]);
  await userEvent.keyboard("{Home}{Enter}");
  expect(onSelect).toHaveBeenLastCalledWith(items[0]);
  expect(readKeyEngineSnapshot().pending).toEqual([]);
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(document.body);
  expect(resolveKeyScope()).toBe("chat");
});

it("lets a control handle Escape first and keeps the plain button leader policy", async () => {
  const activated = vi.fn();
  await using screen = await render(
    <div data-chat-column-maximized-away="false">
      <ChatBufferFixture />
      <div data-mesura-owns-keys>
        <button
          onKeyDown={(event) => {
            if (event.key === "Escape") event.preventDefault();
          }}
        >
          Owned
        </button>
      </div>
      <button onClick={activated}>Plain</button>
    </div>,
  );
  using _engine = engine();
  await screen.getByRole("button", { name: "Owned" }).click();
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Owned" }).element());
  await screen.getByRole("button", { name: "Plain" }).click();
  activated.mockClear();
  await userEvent.keyboard("{Enter}");
  expect(activated).toHaveBeenCalledOnce();
  await userEvent.keyboard(" ");
  expect(readKeyEngineSnapshot().pending).toEqual(["<Space>"]);
  expect(activated).toHaveBeenCalledOnce();
});

function PaneSeparator({ resize }: { resize: (size: number) => number }) {
  const props = usePaneEdge({
    id: "terminal-drawer",
    side: "top",
    enabled: true,
    size: () => 200,
    resizeTo: resize,
    reset: () => {},
  });
  return <div role="separator" aria-label="Terminal height" {...props} />;
}

it("preserves the terminal separator arrows through its existing passthrough scope", async () => {
  const resize = vi.fn((size: number) => size);
  await using screen = await render(
    <div data-chat-column-maximized-away="false">
      <ChatBufferFixture />
      <aside data-terminal-owner="drawer">
        <PaneSeparator resize={resize} />
      </aside>
    </div>,
  );
  using _engine = engine();
  await act(() => (screen.getByRole("separator").element() as HTMLElement).focus());
  expect(resolveKeyScope()).toBe("passthrough");
  await userEvent.keyboard("{ArrowUp}");
  expect(resize).toHaveBeenCalledWith(200 + Math.round(window.innerHeight * 0.05));
});
