// @vitest-environment happy-dom
// Drives `composerSurface` the way the key engine does (`handleKey`, `reset`)
// and the composer does (`registerComposerVimAdapter`), and reads the
// attribute `mesura.css` draws the composer's Vim ring from.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { composerSurface, registerComposerVimAdapter } from "./composerSurface";

const PROMPT = "hello world";

function mountComposer(): { surface: HTMLElement; editor: HTMLElement } {
  document.body.innerHTML = `
    <div data-chat-composer-main-surface="true">
      <div data-testid="composer-editor" contenteditable="true">${PROMPT}</div>
    </div>`;
  return {
    surface: document.querySelector<HTMLElement>("[data-chat-composer-main-surface]")!,
    editor: document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!,
  };
}

/** Hands the surface a token as the key engine does, with its keydown event. */
function press(token: string): boolean {
  const key = token === "<Esc>" ? "Escape" : token;
  return composerSurface.handleKey(token, new KeyboardEvent("keydown", { key }));
}

const ringOf = (surface: HTMLElement) => surface.getAttribute("data-mesura-composer-vim");

describe("composer Vim ring", () => {
  let surface: HTMLElement;
  let editor: HTMLElement;
  let disposeAdapter: () => void;

  beforeEach(() => {
    ({ surface, editor } = mountComposer());
    disposeAdapter = registerComposerVimAdapter({
      read: () => ({ prompt: PROMPT, cursor: 5 }),
      write: () => {},
      setCursor: () => {},
    });
  });

  afterEach(() => {
    composerSurface.reset();
    disposeAdapter();
    document.body.innerHTML = "";
  });

  it("rings the composer surface in normal and visual mode and clears it in insert", () => {
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
    press("<Esc>");
    expect(ringOf(surface)).toBe("normal");

    editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(ringOf(surface)).toBeNull();
    expect(editor.hasAttribute("data-mesura-vim")).toBe(false);
  });

  it("clears the composer ring when Vim mode turns off", () => {
    press("<Esc>");
    press("v");
    expect(ringOf(surface)).toBe("visual");

    // `configureKeyEngine({ enabled: false })` resets every registered surface.
    composerSurface.reset();
    expect(ringOf(surface)).toBeNull();
  });

  it("clears the composer ring when the editor unmounts before its surface", () => {
    press("<Esc>");
    expect(ringOf(surface)).toBe("normal");

    editor.remove();
    disposeAdapter();
    expect(ringOf(surface)).toBeNull();
    expect(composerSurface.mode()).toBe("insert");
  });
});
