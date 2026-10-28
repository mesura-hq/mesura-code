import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { vi } from "vite-plus/test";

import { collapseExpandedComposerCursor, expandCollapsedComposerCursor } from "~/composer-logic";
import {
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
} from "~/composer-rich-text-doc";
import {
  composerSurface,
  registerComposerVimAdapter,
  type ComposerVimAdapter,
} from "~/keys/composer/composerSurface";

/** Owns a DOM fixture without replacing the browser runner's document body. */
export function mountKeyDom(html = "") {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return {
    container,
    byTestId: (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!,
    [Symbol.dispose]() {
      window.getSelection()?.removeAllRanges();
      container.remove();
    },
  };
}

/**
 * Captures an app installer that has no uninstall API. Each test then owns the
 * listeners, while the app's module keeps its normal install-once identity.
 */
export function createWindowListenerFixture(install: () => void) {
  const listeners: Array<{
    readonly type: string;
    readonly listener: EventListenerOrEventListenerObject;
    readonly options?: boolean | AddEventListenerOptions | undefined;
  }> = [];
  {
    using _capture = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener, options) => {
        listeners.push({ type, listener, options });
      });
    install();
  }
  return () => {
    for (const { type, listener, options } of listeners) {
      window.addEventListener(type, listener, options);
    }
    return {
      [Symbol.dispose]() {
        for (const { type, listener, options } of listeners) {
          window.removeEventListener(type, listener, options);
        }
      },
    };
  };
}

const composerListeners = createWindowListenerFixture(() => {
  const unregister = registerComposerVimAdapter({
    read: () => ({ prompt: "", cursor: 0 }),
    write: () => {},
    setCursor: () => {},
    editor: () => null,
  });
  unregister();
});

/** Owns the composer adapter, focus listeners, and surface reset for one test. */
export function registerTestComposerAdapter(adapter: ComposerVimAdapter) {
  using stack = new DisposableStack();
  stack.use(composerListeners());
  stack.defer(registerComposerVimAdapter(adapter));
  stack.defer(() => composerSurface.reset());
  const lifetime = stack.move();
  return {
    dispose: () => lifetime.dispose(),
    [Symbol.dispose]: () => lifetime.dispose(),
  };
}

/**
 * A plain-text composer: a real ProseMirror editor, one paragraph per line, inside the composer's
 * surface. Reads and writes are synchronous, standing in for the composer's controlled prompt and
 * collapsed cursor; rich blocks and inline tokens need `mountVimComposer`.
 */
export function mountPlainComposer(prompt: string) {
  const surface = document.createElement("div");
  surface.setAttribute("data-chat-composer-main-surface", "true");
  document.body.append(surface);
  const editor = new Editor({
    element: surface,
    extensions: [StarterKit],
    content: paragraphsOf(prompt),
    editorProps: { attributes: { "data-testid": "composer-editor" } },
  });
  const element = editor.view.dom as HTMLElement;
  const readPrompt = () => serializeEditorDoc(editor.state.doc).value;
  const readCursor = () => {
    const map = serializeEditorDoc(editor.state.doc);
    const expanded = flatToMarkdown(map, pmToFlat(map, editor.state.selection.from));
    return collapseExpandedComposerCursor(map.value, expanded);
  };
  const setCursor = (cursor: number) => {
    const map = serializeEditorDoc(editor.state.doc);
    const expanded = expandCollapsedComposerCursor(map.value, cursor);
    editor.commands.setTextSelection(flatToPm(map, markdownToFlat(map, expanded)));
  };
  const replace = (next: string, cursor = next.length) => {
    editor.commands.setContent(paragraphsOf(next));
    setCursor(cursor);
  };
  setCursor(prompt.length);
  return {
    editor,
    element,
    surface,
    prompt: readPrompt,
    cursor: readCursor,
    setCursor,
    /** Replaces the prompt from outside the Vim layer, as a draft switch or a restore does. */
    replace,
    /** Types at the caret as the editor's own input does. */
    type: (text: string) => {
      editor.commands.insertContent(text);
    },
    adapter: (draftKey: () => string, writes?: Array<{ prompt: string; cursor: number }>) => ({
      draftKey,
      read: () => ({ prompt: readPrompt(), cursor: readCursor() }),
      write: (next: string, cursor: number) => {
        writes?.push({ prompt: next, cursor });
        replace(next, cursor);
      },
      setCursor,
      editor: () => editor,
    }),
    [Symbol.dispose]() {
      editor.destroy();
      surface.remove();
    },
  };
}

function paragraphsOf(prompt: string) {
  return {
    type: "doc",
    content: prompt.split("\n").map((line) => ({
      type: "paragraph",
      content: line.length > 0 ? [{ type: "text", text: line }] : [],
    })),
  };
}
