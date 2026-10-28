import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { createWindowListenerFixture } from "~/test/keyBrowserFixtures";
import { configureKeyEngine, installKeyEngine, registerKeySurface } from "../keyEngine";
import { useCursorOverlays } from "../cursorOverlayStore";
import { chatSurface, clearChatSurfacePaint, setChatThreadKey } from "./chatSurface";

const engineListeners = createWindowListenerFixture(installKeyEngine);

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
  lifetime.use(engineListeners());
  lifetime.defer(registerKeySurface(chatSurface));
  configureKeyEngine({ enabled: true });
  lifetime.defer(() => configureKeyEngine({ enabled: false }));
  clearChatSurfacePaint();
  setChatThreadKey(content);
  chatSurface.reset();
  lifetime.defer(() => {
    chatSurface.reset();
    clearChatSurfacePaint();
  });
  const chat = screen.container.querySelector<HTMLElement>("[data-assistant-citation-viewport]")!;
  chat.focus();
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

it("returns from an iframe to the object focused with the mouse", async () => {
  await using fixture = await setup(
    '<p>Earlier text</p><div data-mesura-chat-object="html-render" style="height:80px"><iframe data-mesura-chat-object-entry title="Mouse document"></iframe></div><p>Later text</p>',
  );
  await userEvent.keyboard("l");
  const frame = fixture.chat.querySelector("iframe")!;
  frame.focus();
  fixture.chat.focus();
  await userEvent.keyboard("v");
  expect(
    window.getSelection()?.getRangeAt(0).cloneContents().querySelector("iframe"),
  ).not.toBeNull();
});

it("selects expanded readable work output while controls stay excluded", async () => {
  await using fixture = await setup(
    '<div role="button"><span>Run command</span><div data-mesura-readable><pre>alpha\n\nbeta</pre><button>Copy</button></div></div>',
  );
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await userEvent.keyboard("Vjjy");
  expect(clipboard).toHaveBeenCalledWith("alpha\n\nbeta\n");
});

it("moves only through visible content and treats separated status labels as words", async () => {
  await using fixture = await setup(
    '<details><summary>Summary</summary><p>Hidden</p></details><p style="display:none">Also hidden</p><div style="user-select:none">Chrome</div><div style="display:flex;gap:10px"><span>Factory</span><span>degraded</span></div>',
  );
  await userEvent.keyboard("jwv");
  expect(window.getSelection()?.toString()).toBe("d");
});

it("moves vertically in the same table cell and yanks a tab-separated row", async () => {
  await using fixture = await setup(
    '<div style="width:160px;overflow-x:auto" data-testid="table-scroll"><table style="width:700px;table-layout:fixed"><tr><th>Metric</th><th>Value</th></tr><tr><td>Mode</td><td>Normal</td></tr></table></div>',
  );
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await userEvent.keyboard("wjv");
  expect(window.getSelection()?.toString()).toBe("N");
  const scroller = fixture.chat.querySelector<HTMLElement>('[data-testid="table-scroll"]')!;
  expect(scroller.scrollLeft).toBeGreaterThan(0);
  await userEvent.keyboard("{Escape}Vy");
  expect(clipboard).toHaveBeenCalledWith("Mode\tNormal\n");
});
