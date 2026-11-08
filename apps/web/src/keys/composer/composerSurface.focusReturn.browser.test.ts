import { freshTestId } from "~/test/freshTestId";
// Durable cancellation checks for the shared focus snapshot used by the real
// file-manager layer. AppRoot.fileManagerFocusReturn.fence.browser.test.tsx exercises
// the actual composer reveal, editor, mode, undo and modal lifecycle.
import { describe, expect, it } from "vite-plus/test";
import { mountPlainComposer, registerTestComposerAdapter } from "~/test/keyBrowserFixtures";

import { captureComposerFocusReturn, composerSurface } from "./composerSurface";

function setup() {
  using stack = new DisposableStack();
  const composer = stack.use(mountPlainComposer("hello world"));
  const editor = composer.element;
  const otherOwner = composer.surface.appendChild(document.createElement("button"));
  const draft = { key: freshTestId("composer-draft") };
  const adapter = composer.adapter(() => draft.key);
  stack.use(registerTestComposerAdapter({ ...adapter, setCursor: () => editor.focus() }));
  composer.setCursor(2);
  editor.focus();
  composerSurface.handleKey("<Esc>", new KeyboardEvent("keydown", { key: "Escape" }));
  expect(composerSurface.label()).toBe("NORMAL");
  const lifetime = stack.move();
  return {
    editor,
    otherOwner,
    draft,
    composer,
    [Symbol.dispose]: () => lifetime.dispose(),
  };
}

describe("composer modal-return snapshot identity", () => {
  it.each(["draft identity", "draft content", "editor identity"])(
    "composer return cancellation: changed %s retains the next owner without a NORMAL receipt",
    (change) => {
      using fixture = setup();
      const { editor, otherOwner, draft, composer } = fixture;
      const restore = captureComposerFocusReturn(editor, () => editor.focus());
      expect(restore).not.toBeNull();
      otherOwner.focus();
      if (change === "draft identity") draft.key = "second-draft";
      else if (change === "draft content") composer.replace("changed draft");
      else {
        const replacement = editor.cloneNode(true);
        editor.replaceWith(replacement);
      }
      restore!();
      expect(document.activeElement).toBe(otherOwner);
      expect(composerSurface.label()).toBe("INSERT");
      // A later independent entry must not inherit a stale NORMAL receipt.
      const mountedEditor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
      mountedEditor.focus();
      expect(document.activeElement).toBe(mountedEditor);
      expect(composerSurface.label()).toBe("INSERT");
    },
  );
});
