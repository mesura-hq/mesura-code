// @vitest-environment happy-dom
// Entry point: `resolveKeyScope` (`focusScope.ts`), which the key engine calls
// on every keydown with the focused element. The layout carries the pane root
// attributes the app renders (`paneFocus.ts`), and focus moves with
// `element.focus()` as a click or a chord would move it.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { resolveKeyScope } from "./focusScope";

const LAYOUT = `
  <div data-slot="sidebar" data-state="expanded">
    <div data-app-sidebar>
      <button data-testid="sidebar-row">row</button>
      <input data-testid="sidebar-search" type="search" />
    </div>
  </div>
  <div data-chat-column-maximized-away="false">
    <div data-testid="chat-focus" tabindex="0">chat</div>
    <div data-testid="composer-editor" contenteditable="true"><span data-testid="composer-inner">hi</span></div>
    <div data-terminal-owner="drawer"><textarea data-testid="terminal-input"></textarea></div>
  </div>
  <div data-preview-panel-mode="inline">
    <button data-testid="panel-button">refresh</button>
    <div class="monaco-editor"><textarea data-testid="monaco-input"></textarea></div>
    <div role="tree" tabindex="0" data-testid="file-tree"></div>
  </div>`;

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

/** Focuses an element and resolves the scope the engine would read for the next key. */
function scopeAfterFocusing(id: string) {
  const element = byTestId(id);
  element.focus();
  return resolveKeyScope(element);
}

/** Drops focus to `<body>`, as `Esc Esc` in the composer and leaving Neovim do. */
function scopeAfterBlurToBody() {
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  return resolveKeyScope(document.body);
}

beforeEach(() => {
  document.body.innerHTML = LAYOUT;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("resolveKeyScope by focused element", () => {
  it("reads the composer scope inside the composer editor", () => {
    expect(scopeAfterFocusing("composer-editor")).toBe("composer");
    expect(resolveKeyScope(byTestId("composer-inner"))).toBe("composer");
  });

  it("reads the insert scope in a text input outside the composer", () => {
    expect(scopeAfterFocusing("sidebar-search")).toBe("insert");
  });

  it("reads the passthrough scope in the terminal and Monaco", () => {
    expect(scopeAfterFocusing("terminal-input")).toBe("passthrough");
    expect(scopeAfterFocusing("monaco-input")).toBe("passthrough");
  });

  it("reads the tree scope in a tree, which leaves the leader to the keymap", () => {
    expect(scopeAfterFocusing("file-tree")).toBe("tree");
  });

  it("reads the sidebar, chat and panel scopes from the focused pane", () => {
    expect(scopeAfterFocusing("sidebar-row")).toBe("sidebar");
    expect(scopeAfterFocusing("chat-focus")).toBe("chat");
    expect(scopeAfterFocusing("panel-button")).toBe("panel");
  });

  it("reads the passthrough scope while the command palette is open, even from the composer", () => {
    document.body.insertAdjacentHTML("beforeend", "<div data-command-palette></div>");
    expect(scopeAfterFocusing("composer-editor")).toBe("passthrough");
    expect(scopeAfterFocusing("chat-focus")).toBe("passthrough");
  });

  it("reads the passthrough scope while a modal layer is open behind focus", () => {
    document.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-modal="true"></div>');
    expect(scopeAfterFocusing("chat-focus")).toBe("passthrough");
  });
});

describe("resolveKeyScope after a blur to body", () => {
  it("falls back to the last focused pane once focus drops to body", () => {
    scopeAfterFocusing("sidebar-row");
    expect(scopeAfterBlurToBody()).toBe("sidebar");

    scopeAfterFocusing("panel-button");
    expect(scopeAfterBlurToBody()).toBe("panel");
  });

  it("hands the keys to the chat when the last focused pane went away with focus in it", () => {
    // The panel's last tab closes: the panel unmounts and focus drops to body.
    scopeAfterFocusing("panel-button");
    document.querySelector("[data-preview-panel-mode]")!.remove();
    expect(document.activeElement).toBe(document.body);
    expect(resolveKeyScope(document.body)).toBe("chat");

    // The sidebar collapses while a row has focus.
    scopeAfterFocusing("sidebar-row");
    document.querySelector<HTMLElement>('[data-slot="sidebar"]')!.dataset.state = "collapsed";
    expect(scopeAfterBlurToBody()).toBe("chat");
  });

  it("treats a blur to body after the terminal as terminal passthrough", () => {
    scopeAfterFocusing("terminal-input");
    expect(scopeAfterBlurToBody()).toBe("passthrough");
  });

  // Regression: the composer branch returned before the focused pane was
  // read, so the terminal stayed recorded as the last pane. Terminal
  // focused, click into the composer, `Esc Esc`: every key then went to the
  // terminal's passthrough instead of the chat.
  it("records the chat pane from the composer before its early return", () => {
    expect(scopeAfterFocusing("terminal-input")).toBe("passthrough");
    expect(scopeAfterFocusing("composer-editor")).toBe("composer");
    expect(scopeAfterBlurToBody()).toBe("chat");
  });
});
