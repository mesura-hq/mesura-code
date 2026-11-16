import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File } from "@pierre/diffs/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { isMacPlatform } from "~/lib/utils";
import { installFileEditorDismissal } from "./fileEditorDismissal";

describe("installFileEditorDismissal", () => {
  it.each(["forward", "backward"] as const)(
    "keeps a %s text selection made outside the file while its search is open",
    async (direction) => {
      let editor: Editor<"file" | "file-diff", undefined, undefined> | undefined;
      const createEditor: EditorFactory<undefined, undefined> = (...args) =>
        (editor = new Editor(...args));
      // File paints nothing until the shared highlighter has loaded; once it has, mount renders synchronously.
      await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
      await using screen = await render(
        <>
          <p>Assistant reply</p>
          <div data-testid="file-surface">
            <EditProvider createEditor={createEditor}>
              <File file={{ name: "server.ts", contents: "const server = 1;\n" }} edit />
            </EditProvider>
          </div>
        </>,
      );
      const shadowRoot = () => screen.container.querySelector("diffs-container")?.shadowRoot;
      const content = shadowRoot()?.querySelector<HTMLElement>("[data-content]");
      expect(content).toBeTruthy();

      editor!.setSelections([
        { start: { line: 0, character: 8 }, end: { line: 0, character: 8 }, direction: "none" },
      ]);
      const isMac = isMacPlatform(navigator.platform);
      content!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => expect(CSS.highlights.get("diffs-search-current")?.size).toBe(1));

      const onDismiss = vi.fn();
      using _dismissal = {
        [Symbol.dispose]: installFileEditorDismissal({
          root: screen.getByTestId("file-surface").element() as HTMLElement,
          editor: {
            hasTextFocus: () => Boolean(shadowRoot()?.activeElement),
            collapseSelection: () =>
              editor!.setSelections(
                (editor!.getViewState().selections ?? []).map((selection) => ({
                  start: selection.end,
                  end: selection.end,
                  direction: "none",
                })),
              ),
            blur: () => editor!.blur(),
          },
          isBlocked: () => false,
          onDismiss,
        }),
      };
      const reply = screen.getByText("Assistant reply").element();
      const text = reply.firstChild!;
      const selection = window.getSelection()!;
      using _selection = { [Symbol.dispose]: () => selection.removeAllRanges() };
      const anchor = direction === "backward" ? "Assistant reply".length : 0;
      const focus = direction === "backward" ? 0 : "Assistant reply".length;
      selection.setBaseAndExtent(text, anchor, text, focus);
      reply.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));

      expect(onDismiss).toHaveBeenCalledOnce();
      expect(selection.toString()).toBe("Assistant reply");
      expect(selection.anchorNode).toBe(text);
      expect(selection.anchorOffset).toBe(anchor);
      expect(selection.focusNode).toBe(text);
      expect(selection.focusOffset).toBe(focus);
      expect(shadowRoot()?.activeElement).not.toBe(content);
      const selections = editor!.getViewState().selections;
      expect(selections).toHaveLength(1);
      expect(selections![0]!.start).toEqual(selections![0]!.end);
    },
  );
});
