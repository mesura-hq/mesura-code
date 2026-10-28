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
  setChatThreadKey(content);
  chatSurface.reset();
  lifetime.defer(() => {
    chatSurface.reset();
    clearChatSurfacePaint();
  });
  const chat = screen.container.querySelector<HTMLElement>("[data-assistant-citation-viewport]")!;
  chat.focus();
  const listener = (event: KeyboardEvent) => {
    if (
      chatSurface.handleKey(
        event.key === "Escape" ? "<Esc>" : event.key === "Enter" ? "<CR>" : event.key,
        event,
      )
    )
      event.preventDefault();
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

it("enters an iframe object and copies a math object as complete TeX", async () => {
  await using fixture = await setup(
    '<div data-mesura-chat-object="html-render" style="height:80px"><iframe data-mesura-chat-object-entry title="Document"></iframe></div><span data-mesura-chat-object="math" data-markdown-math="inline" data-markdown-copy="x^2">x²</span>',
  );
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await userEvent.keyboard("v");
  expect(
    window.getSelection()?.getRangeAt(0).cloneContents().querySelector("iframe"),
  ).not.toBeNull();
  await userEvent.keyboard("{Escape}{Enter}");
  expect(document.activeElement).toBe(fixture.chat.querySelector("iframe"));
  fixture.chat.focus();
  await userEvent.keyboard("jy");
  expect(clipboard).toHaveBeenCalledWith("x^2");
  await expect.element(fixture.screen.getByTestId("cursor")).not.toHaveTextContent("none");
});

it("toggles diagram source through its existing control and yanks image alt text", async () => {
  await using fixture = await setup(
    '<div><button data-mesura-chat-object-toggle>Show code</button><div data-mesura-chat-object="diagram" data-markdown-copy="```mermaid\ngraph TD\n```" style="height:50px">Diagram</div></div><img data-mesura-chat-object="image" alt="A chart" style="width:50px;height:50px">',
  );
  const toggle = fixture.chat.querySelector("button")!;
  using activate = vi.spyOn(toggle, "click");
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await userEvent.keyboard("y{Enter}");
  expect(clipboard).toHaveBeenCalledWith("```mermaid\ngraph TD\n```");
  expect(activate).toHaveBeenCalledOnce();
  await userEvent.keyboard("jy");
  expect(clipboard).toHaveBeenLastCalledWith("A chart");
});
