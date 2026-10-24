// @vitest-environment happy-dom
// Durable cancellation checks for the shared focus snapshot used by the real
// file-manager layer. AppRoot.fileManagerFocusReturn.fence.test.tsx exercises
// the actual composer reveal, editor, mode, undo and modal lifecycle.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  captureComposerFocusReturn,
  composerSurface,
  registerComposerVimAdapter,
} from "./composerSurface";

describe("composer modal-return snapshot identity", () => {
  let editor: HTMLDivElement;
  let otherOwner: HTMLButtonElement;
  let draftKey: string;
  let prompt: string;
  let dispose: () => void;
  let replacement: Node | null;

  beforeEach(() => {
    prompt = "hello world";
    draftKey = "first-draft";
    replacement = null;
    editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.setAttribute("data-testid", "composer-editor");
    editor.textContent = prompt;
    otherOwner = document.createElement("button");
    document.body.append(editor, otherOwner);
    dispose = registerComposerVimAdapter({
      read: () => ({ prompt, cursor: 2 }),
      write: () => {},
      setCursor: () => editor.focus(),
      draftKey: () => draftKey,
    });
    editor.focus();
    composerSurface.handleKey("<Esc>", new KeyboardEvent("keydown", { key: "Escape" }));
    expect(composerSurface.label()).toBe("NORMAL");
  });

  afterEach(() => {
    composerSurface.reset();
    dispose();
    editor.remove();
    otherOwner.remove();
    replacement?.parentNode?.removeChild(replacement);
  });

  it.each(["draft identity", "draft content", "editor identity"])(
    "composer return cancellation: changed %s retains the next owner without a NORMAL receipt",
    (change) => {
      const restore = captureComposerFocusReturn(editor, () => editor.focus());
      expect(restore).not.toBeNull();
      otherOwner.focus();
      if (change === "draft identity") draftKey = "second-draft";
      else if (change === "draft content") prompt = "changed draft";
      else {
        replacement = editor.cloneNode(true);
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
