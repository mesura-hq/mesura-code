import { getSchema, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import { atomCharacterEpoch, inlineNodesFor, snapshotComposerDoc } from "./composerDocument";

const Mention = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({ path: { default: "" } }),
});
const schema = getSchema([StarterKit, Mention]);

function docWithMentions(paths: readonly string[]) {
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: paths.map((path) => ({ type: "composer-mention", attrs: { path } })),
      },
    ],
  });
}

const pathOf = (character: string) =>
  inlineNodesFor(character, schema, [])[0]?.attrs.path as string | undefined;

describe("composer document atoms", () => {
  it("reads lines, list items and code lines as the text shown, with one position per character", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Read" }] }],
            },
          ],
        },
        { type: "codeBlock", content: [{ type: "text", text: "a\n\nb" }] },
      ],
    });
    const snapshot = snapshotComposerDoc(doc);
    expect(snapshot.text).toBe("Read\na\n\nb");
    for (const line of snapshot.lines) {
      const shown = snapshot.text.slice(line.start, line.start + line.length);
      expect(doc.textBetween(line.pmStart, line.pmStart + line.length)).toBe(shown);
    }
  });

  it("resets the atom table only between documents and marks the reset with a new epoch", () => {
    const first = snapshotComposerDoc(docWithMentions(["kept-0"])).text;
    expect(pathOf(first)).toBe("kept-0");
    const epoch = atomCharacterEpoch();
    let batch = 0;
    while (atomCharacterEpoch() === epoch) {
      const paths = Array.from({ length: 400 }, (_, index) => `batch-${batch}-${index}`);
      const { text } = snapshotComposerDoc(docWithMentions(paths));
      // Every character of a document resolves to that document's own atom.
      expect([...text].map(pathOf)).toEqual(paths);
      batch += 1;
    }
    expect(atomCharacterEpoch()).toBe(epoch + 1);
  });
});
