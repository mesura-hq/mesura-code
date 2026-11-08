import type { ServerProviderSkill } from "@t3tools/contracts";
import { createRef, useSyncExternalStore } from "react";

import { act, render } from "../../test/render";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
import { collapseExpandedComposerCursor } from "~/composer-logic";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { composerSurface } from "~/keys/composer/composerSurface";

import { freshTestId } from "./freshTestId";
import { registerTestComposerAdapter } from "./keyBrowserFixtures";

/**
 * The real composer editor under the Vim layer, wired as `useMesuraComposerInput` wires
 * `ChatComposer`: a controlled prompt and collapsed cursor, and an adapter whose `write` replaces
 * the prompt through the editor's controlled value.
 */
export async function mountVimComposer(
  prompt: string,
  options: {
    readonly richText?: boolean;
    readonly skills?: ReadonlyArray<ServerProviderSkill>;
  } = {},
) {
  await using stack = new AsyncDisposableStack();
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const draftKey = freshTestId("vim-composer-draft");
  const writes: Array<{ readonly prompt: string; readonly cursor: number }> = [];
  // The controlled prompt and collapsed cursor, held outside React as ChatComposer's state is.
  let controlled = { value: prompt, cursor: collapseExpandedComposerCursor(prompt, prompt.length) };
  const listeners = new Set<() => void>();
  const setControlled = (next: typeof controlled) => {
    controlled = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  function Harness() {
    const { value, cursor } = useSyncExternalStore(subscribe, () => controlled);
    return (
      <div data-chat-composer-main-surface="true">
        <ComposerPromptEditor
          editorRef={editorRef}
          value={value}
          cursor={cursor}
          richTextEnabled={options.richText ?? true}
          contextRecords={new Map()}
          skills={options.skills ?? []}
          disabled={false}
          placeholder=""
          onChange={(nextValue, nextCursor) =>
            setControlled({ value: nextValue, cursor: nextCursor })
          }
          onPaste={() => {}}
        />
      </div>
    );
  }

  const screen = stack.use(await render(<Harness />));
  stack.use(
    registerTestComposerAdapter({
      draftKey: () => draftKey,
      read: () => ({
        prompt: controlled.value,
        cursor: editorRef.current?.readSnapshot().cursor ?? controlled.value.length,
      }),
      write: (next, cursor) => {
        writes.push({ prompt: next, cursor });
        setControlled({ value: next, cursor });
      },
      setCursor: (cursor) => editorRef.current?.focusAt(cursor),
      editor: () => editorRef.current?.editor() ?? null,
    }),
  );
  const editor = () => {
    const instance = editorRef.current?.editor();
    if (!instance) throw new Error("the composer editor did not mount");
    return instance;
  };
  const element = () => editor().view.dom as HTMLElement;
  // `commands.focus` waits a frame; a focus arriving after the first key would reset the mode.
  await act(() => {
    editor().view.focus();
    editor().commands.setTextSelection(editor().state.doc.content.size);
  });

  /** Hands the surface one token as the key engine does, with its keydown event. */
  const press = (token: string): boolean => {
    const ctrl = /^<C-(.)>$/.exec(token);
    const key = token === "<Esc>" ? "Escape" : (ctrl?.[1] ?? token);
    return composerSurface.handleKey(
      token,
      new KeyboardEvent("keydown", { key, ctrlKey: ctrl !== null }),
    );
  };

  const environment = stack.move();
  return {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    screen,
    draftKey,
    writes,
    editor,
    element,
    /** The prompt the editor serializes to now. */
    prompt: () => serializeEditorDoc(editor().state.doc).value,
    /** The editor's document as node type names, outermost first. */
    blocks: () => {
      const names: string[] = [];
      editor().state.doc.forEach((node) => names.push(node.type.name));
      return names;
    },
    /** Presses each token in turn; React commits after each, as after a real key. */
    keys: async (...tokens: string[]) => {
      for (const token of tokens) await act(() => void press(token));
    },
    press,
    /** Types text at the caret as the editor's own input does, in insert mode. */
    type: async (text: string) =>
      act(() => {
        editor().commands.insertContent(text);
      }),
    /** What the composer's cursor highlight paints, and the visual selection. */
    painted: () => ({
      cursor: [...(CSS.highlights.get("mesura-composer-cursor") ?? [])].map(String).join(""),
      visual: [...(CSS.highlights.get("mesura-composer-visual") ?? [])].map(String),
    }),
  };
}
