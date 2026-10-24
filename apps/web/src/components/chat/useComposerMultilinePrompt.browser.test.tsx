import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";

const SHORT_PROMPT = "A draft with several words";

function Composer({ editorKey, prompt }: { editorKey: string | null; prompt: string }) {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const isMultiline = useComposerMultilinePrompt(body);

  return (
    <>
      <div
        ref={setBody}
        data-testid="composer-body"
        style={{ boxSizing: "border-box", width: 320, height: 160, paddingInline: 16 }}
      >
        {editorKey !== null && (
          <div
            key={editorKey}
            data-testid="composer-editor"
            style={{
              width: "100%",
              minHeight: 80,
              fontFamily: "monospace",
              fontSize: 16,
              lineHeight: "20px",
              whiteSpace: "pre-wrap",
            }}
          >
            {prompt}
          </div>
        )}
      </div>
      <output data-testid="prompt-layout">{isMultiline ? "multiline" : "single line"}</output>
    </>
  );
}

it("replaces the keyed editor's resize subscription while retaining the body and shared observer", async () => {
  using observe = vi.spyOn(ResizeObserver.prototype, "observe");
  using unobserve = vi.spyOn(ResizeObserver.prototype, "unobserve");
  using disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
  // This fixture exercises DOM layout without navigation or connection state.
  await using screen = await render(
    <Composer editorKey="thread" prompt={"first line\nsecond line"} />,
    { router: false },
  );
  const body = screen.container.querySelector<HTMLDivElement>('[data-testid="composer-body"]')!;
  const previousEditor = screen.container.querySelector<HTMLDivElement>(
    '[data-testid="composer-editor"]',
  )!;
  const layout = screen.getByTestId("prompt-layout");
  await expect.element(layout).toHaveTextContent("multiline");
  expect(observe.mock.calls.map(([target]) => target)).toEqual([body, previousEditor]);
  const bodySize = [body.clientWidth, body.clientHeight];

  await screen.rerender(<Composer editorKey="draft" prompt={SHORT_PROMPT} />);
  const editor = screen.container.querySelector<HTMLDivElement>('[data-testid="composer-editor"]')!;
  await expect.element(layout).toHaveTextContent("single line");
  expect(editor).not.toBe(previousEditor);
  expect(previousEditor.isConnected).toBe(false);
  expect(unobserve).toHaveBeenCalledExactlyOnceWith(previousEditor);
  expect(observe.mock.calls.map(([target]) => target)).toEqual([body, previousEditor, editor]);
  expect(new Set(observe.mock.contexts).size).toBe(1);
  expect(disconnect).not.toHaveBeenCalled();
  expect(editor.clientHeight).toBe(80);

  // Attribute changes bypass the mutation subscription. Only the replacement
  // editor resizes because the body has a fixed size.
  editor.style.width = "80px";
  await expect.element(layout).toHaveTextContent("multiline");
  expect([body.clientWidth, body.clientHeight]).toEqual(bodySize);

  editor.style.width = "100%";
  await expect.element(layout).toHaveTextContent("single line");
  expect(observe.mock.calls.map(([target]) => target)).toEqual([body, previousEditor, editor]);

  await screen.unmount();
  expect(unobserve.mock.calls.map(([target]) => target)).toEqual([previousEditor, editor]);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(disconnect.mock.contexts[0]).toBe(observe.mock.contexts[0]);
});

it("observes editors added after mount and preserves content and padded-width measurements across removal", async () => {
  using observe = vi.spyOn(ResizeObserver.prototype, "observe");
  using unobserve = vi.spyOn(ResizeObserver.prototype, "unobserve");
  using disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
  // This fixture exercises DOM layout without navigation or connection state.
  await using screen = await render(<Composer editorKey={null} prompt="" />, { router: false });
  const body = screen.container.querySelector<HTMLDivElement>('[data-testid="composer-body"]')!;
  const layout = screen.getByTestId("prompt-layout");
  expect(observe.mock.calls.map(([target]) => target)).toEqual([body]);

  await screen.rerender(<Composer editorKey="draft" prompt={SHORT_PROMPT} />);
  const editor = screen.container.querySelector<HTMLDivElement>('[data-testid="composer-editor"]')!;
  await vi.waitFor(() => expect(observe).toHaveBeenCalledWith(editor));
  await expect.element(layout).toHaveTextContent("single line");

  editor.style.width = "max-content";
  editor.style.whiteSpace = "pre";
  const editorWidth = editor.clientWidth;
  // The prompt stays on one line. The padded body alone crosses its width.
  body.style.width = `${editorWidth + 16}px`;
  await expect.element(layout).toHaveTextContent("multiline");
  expect(editor.clientWidth).toBe(editorWidth);

  body.style.width = "320px";
  await expect.element(layout).toHaveTextContent("single line");

  await screen.rerender(<Composer editorKey="draft" prompt={"first line\nsecond line"} />);
  await expect.element(layout).toHaveTextContent("multiline");
  expect(observe.mock.calls.map(([target]) => target)).toEqual([body, editor]);

  await screen.rerender(<Composer editorKey={null} prompt="" />);
  await vi.waitFor(() => expect(unobserve).toHaveBeenCalledExactlyOnceWith(editor));
  expect(editor.isConnected).toBe(false);
  await expect.element(layout).toHaveTextContent("multiline");
  expect(disconnect).not.toHaveBeenCalled();

  await screen.rerender(<Composer editorKey="thread" prompt={SHORT_PROMPT} />);
  const replacement = screen.container.querySelector<HTMLDivElement>(
    '[data-testid="composer-editor"]',
  )!;
  await expect.element(layout).toHaveTextContent("single line");
  expect(observe.mock.calls.map(([target]) => target)).toEqual([body, editor, replacement]);
  expect(new Set(observe.mock.contexts).size).toBe(1);

  await screen.unmount();
  expect(unobserve.mock.calls.map(([target]) => target)).toEqual([editor, replacement]);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
