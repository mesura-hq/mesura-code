import { freshTestId } from "~/test/freshTestId";
// Drives `composerSurface` the way the key engine does (`handleKey`, `reset`)
// and the composer does (`registerComposerVimAdapter`), and reads the
// attribute `mesura.css` draws the composer's Vim ring from.
import { describe, expect, it } from "vite-plus/test";

import { mountKeyDom, registerTestComposerAdapter } from "~/test/keyBrowserFixtures";

import { composerSurface } from "./composerSurface";

const PROMPT = "hello world";

function mountComposer() {
  using stack = new DisposableStack();
  const dom = stack.use(
    mountKeyDom(`
    <div data-chat-composer-main-surface="true">
      <div data-testid="composer-editor" contenteditable="true">${PROMPT}</div>
    </div>`),
  );
  const draftKey = freshTestId("composer-draft");
  const adapter = stack.use(
    registerTestComposerAdapter({
      draftKey: () => draftKey,
      read: () => ({ prompt: PROMPT, cursor: 5 }),
      write: () => {},
      setCursor: () => {},
    }),
  );
  const lifetime = stack.move();
  return {
    [Symbol.dispose]: () => lifetime.dispose(),
    disposeAdapter: () => adapter.dispose(),
    surface: dom.container.querySelector<HTMLElement>("[data-chat-composer-main-surface]")!,
    editor: dom.byTestId("composer-editor"),
  };
}

/** Hands the surface a token as the key engine does, with its keydown event. */
function press(token: string): boolean {
  const key = token === "<Esc>" ? "Escape" : token;
  return composerSurface.handleKey(token, new KeyboardEvent("keydown", { key }));
}

const ringOf = (surface: HTMLElement) => surface.getAttribute("data-mesura-composer-vim");

describe("composer Vim ring", () => {
  it("rings the composer surface in normal and visual mode and clears it in insert", () => {
    using fixture = mountComposer();
    const { surface, editor } = fixture;
    expect(ringOf(surface)).toBeNull();

    expect(press("<Esc>")).toBe(true);
    expect(ringOf(surface)).toBe("normal");
    expect(editor.getAttribute("data-mesura-vim")).toBe("normal");

    press("v");
    expect(ringOf(surface)).toBe("visual");
    expect(editor.getAttribute("data-mesura-vim")).toBe("visual");

    press("<Esc>");
    expect(ringOf(surface)).toBe("normal");

    press("i");
    expect(composerSurface.mode()).toBe("insert");
    expect(ringOf(surface)).toBeNull();
    expect(editor.hasAttribute("data-mesura-vim")).toBe(false);
  });

  it("clears the composer ring when focus leaves the editor", () => {
    using fixture = mountComposer();
    const { surface, editor } = fixture;
    press("<Esc>");
    expect(ringOf(surface)).toBe("normal");

    editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(ringOf(surface)).toBeNull();
    expect(editor.hasAttribute("data-mesura-vim")).toBe(false);
  });

  it("clears the composer ring when Vim mode turns off", () => {
    using fixture = mountComposer();
    const { surface } = fixture;
    press("<Esc>");
    press("v");
    expect(ringOf(surface)).toBe("visual");

    // `configureKeyEngine({ enabled: false })` resets every registered surface.
    composerSurface.reset();
    expect(ringOf(surface)).toBeNull();
  });

  it("clears the composer ring when the editor unmounts before its surface", () => {
    using fixture = mountComposer();
    const { surface, editor } = fixture;
    press("<Esc>");
    expect(ringOf(surface)).toBe("normal");

    editor.remove();
    fixture.disposeAdapter();
    expect(ringOf(surface)).toBeNull();
    expect(composerSurface.mode()).toBe("insert");
  });
});
