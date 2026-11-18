import * as monaco from "monaco-editor";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { createCommentZoneStore } from "./monacoFileComments";

it("keeps a comment zone's controls in the accessibility tree", async () => {
  const host = document.createElement("div");
  host.style.cssText = "width: 600px; height: 300px";
  document.body.append(host);
  const editor = monaco.editor.create(host, { value: "one\ntwo\nthree", automaticLayout: false });
  const store = createCommentZoneStore();
  try {
    const stopObserving = store.synchronize(editor, "2");
    const contentNode = store.getSnapshot().contentNodes.get(2);
    expect(contentNode).toBeDefined();
    const button = document.createElement("button");
    button.textContent = "Start voice dictation";
    contentNode!.append(button);
    await expect
      .element(page.getByRole("button", { name: "Start voice dictation" }))
      .toBeInTheDocument();
    stopObserving?.();
  } finally {
    store.clear();
    editor.dispose();
    host.remove();
  }
});
