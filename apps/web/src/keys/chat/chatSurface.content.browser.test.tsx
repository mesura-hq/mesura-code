import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useCursorOverlays } from "../cursorOverlayStore";
import { chatSurface, clearChatSurfacePaint, setChatThreadKey } from "./chatSurface";

function CursorProbe() {
  const cursor = useCursorOverlays().get("mesura-chat-cursor");
  return (
    <output data-testid="cursor">
      {cursor ? JSON.stringify({ width: cursor.width, height: cursor.height }) : "none"}
    </output>
  );
}

async function setup(content: string) {
  await using lifetime = new AsyncDisposableStack();
  const screen = lifetime.use(
    await render(
      <>
        <div data-assistant-citation-viewport tabIndex={0} data-testid="chat">
          <div data-timeline-row-id="content" dangerouslySetInnerHTML={{ __html: content }} />
        </div>
        <CursorProbe />
      </>,
    ),
  );
  clearChatSurfacePaint();
  setChatThreadKey("content-test");
  chatSurface.reset();
  lifetime.defer(() => {
    chatSurface.reset();
    clearChatSurfacePaint();
  });
  const chat = screen.container.querySelector<HTMLElement>("[data-assistant-citation-viewport]")!;
  chat.focus();
  const listener = (event: KeyboardEvent) => {
    if (chatSurface.handleKey(event.key === "Escape" ? "<Esc>" : event.key)) event.preventDefault();
  };
  chat.addEventListener("keydown", listener);
  lifetime.defer(() => chat.removeEventListener("keydown", listener));
  const owned = lifetime.move();
  return { screen, chat, [Symbol.asyncDispose]: () => owned[Symbol.asyncDispose]() };
}

describe("chat content navigation", () => {
  it("moves onto an empty code line and yanks its newline", async () => {
    await using fixture = await setup("<pre><code>alpha\n\nbeta</code></pre>");
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await userEvent.keyboard("j");
    await expect.element(fixture.screen.getByTestId("cursor")).not.toHaveTextContent("none");
    await userEvent.keyboard("Vjy");
    expect(clipboard).toHaveBeenCalledWith("\nbeta\n");
  });
});
