import { describe, expect, it } from "vite-plus/test";

import { importPastedComposerText, readPastedComposerContext } from "./composerInlineTokenPaste";

function clipboardWith(text: string, extra: Record<string, string> = {}) {
  return {
    getData: (type: string) => (type === "text/plain" ? text : (extra[type] ?? "")),
  };
}

describe("context reference paste with dictation markers", () => {
  it("keeps a dictation marker's job id when a web paste imports a record that shares it", () => {
    const dictation = "[Transcribing](t3-context://v1/dictation/ctx-1)";
    const image = {
      version: 1,
      contextId: "ctx-1",
      kind: "image",
      label: "shot",
      attachmentId: "a",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    const clipboard = (text: string) =>
      clipboardWith(text, {
        "web application/x-t3-context-fragment+json": JSON.stringify({
          version: 1,
          source: { environmentId: "env-1" },
          records: [image],
        }),
      });
    expect(readPastedComposerContext(clipboard(`say ${dictation}`))?.records).toEqual([]);
    const both = clipboard(`![shot](t3-context://v1/image/ctx-1) ${dictation}`);
    expect(importPastedComposerText(both, () => new Map([["ctx-1", "img-new"]]))).toBe(
      `![shot](t3-context://v1/image/img-new) ${dictation}`,
    );
  });
});
