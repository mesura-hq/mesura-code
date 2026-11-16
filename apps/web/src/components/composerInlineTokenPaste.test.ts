import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { type ComposerContextClipboardFragment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { readPastedComposerContext, importPastedComposerText } from "./composerInlineTokenPaste";

const thread = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const clipboard = (data: Record<string, string>) => ({
  getData: (type: string) => data[type] ?? "",
});
const chip = (title: string) =>
  `[${title}](t3-context://v1/thread/${threadContextRecord(thread, title).contextId})`;

/** Imports every record it is offered, as the composer does for a thread its agent can read. */
const importAll =
  (imported: Array<ComposerContextClipboardFragment>) =>
  (fragment: ComposerContextClipboardFragment) => {
    imported.push(fragment);
    return new Map(fragment.records.map((record) => [record.contextId, record.contextId]));
  };

describe("importPastedComposerText", () => {
  it("pastes a copied thread link back as the chip it was copied from", () => {
    const target = threadChipCopyTarget(thread, "Fix the login flow");
    const imported: Array<ComposerContextClipboardFragment> = [];
    const text = importPastedComposerText(
      clipboard({
        "text/plain": `See ${target.value}`,
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: encodeComposerContextFragment(target.fragment!)!,
      }),
      importAll(imported),
    );
    expect(text).toBe(`See ${chip("Fix the login flow")}`);
    expect(imported.map((fragment) => fragment.records)).toEqual([target.fragment!.records]);
  });

  it("makes a chip of a v2 link pasted without T3's clipboard format", () => {
    const text = importPastedComposerText(
      clipboard({ "text/plain": "[Login](t3-thread://v2/env-1/thread-1)" }),
      importAll([]),
    );
    expect(text).toBe(chip("Login"));
  });

  it("keeps the link when the composer cannot take the thread", () => {
    const pasted = "https://app.t3.codes/threads/env-1/thread-1";
    expect(importPastedComposerText(clipboard({ "text/plain": pasted }), () => new Map())).toBe(
      pasted,
    );
  });

  it("imports CRLF and CR clipboard text with LF line breaks", () => {
    expect(
      importPastedComposerText(clipboard({ "text/plain": "x\r\n\r\ny\rz" }), () => new Map()),
    ).toBe("x\n\ny\nz");
  });
});

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
function clipboardWith(text: string, extra: Record<string, string> = {}) {
  return { getData: (type: string) => (type === "text/plain" ? text : (extra[type] ?? "")) };
}
