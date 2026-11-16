// The composer's Vim layer over the real rich-text editor: lists, tasks, code and chips are
// structure, so Vim moves over and edits only the text the editor shows.
import { describe, expect, it } from "vite-plus/test";

import { act } from "../../../test/render";

import { mountVimComposer } from "~/test/vimComposerFixture";

import { composerSurface } from "./composerSurface";
import { snapshotComposerDoc } from "./composerDocument";

const LIST = "1. Read alpha beta.\n2. Review gamma delta.";

/** The text Vim reads, from the editor's document. */
function vimText(fixture: Awaited<ReturnType<typeof mountVimComposer>>): string {
  return snapshotComposerDoc(fixture.editor().state.doc).text;
}

/** The character the editor's caret sits before: where normal mode put it. */
function caretCharacter(fixture: Awaited<ReturnType<typeof mountVimComposer>>): string {
  const { doc, selection } = fixture.editor().state;
  return doc.textBetween(selection.from, Math.min(selection.from + 1, doc.content.size), "\n");
}

function textRuns(fixture: Awaited<ReturnType<typeof mountVimComposer>>) {
  const runs: Array<{ text: string; marks: string[] }> = [];
  fixture.editor().state.doc.descendants((node) => {
    if (node.isText)
      runs.push({ text: node.text!, marks: node.marks.map((mark) => mark.type.name) });
  });
  return runs;
}

describe("composer Vim over rich text", () => {
  it("reads a numbered list as its item text, without the numbers", async () => {
    await using fixture = await mountVimComposer(LIST);
    expect(fixture.blocks()).toEqual(["orderedList"]);
    expect(vimText(fixture)).toBe("Read alpha beta.\nReview gamma delta.");
  });

  it("0 lands on the item's first letter, and v$ selects exactly the item's text", async () => {
    await using fixture = await mountVimComposer(LIST);
    await fixture.keys("<Esc>", "g", "g", "$", "0");
    expect(caretCharacter(fixture)).toBe("R");
    expect(fixture.painted().cursor).toBe("R");

    await fixture.keys("v", "$");
    expect(fixture.painted().visual).toEqual(["Read alpha beta."]);
  });

  it("v E selects to the end of the WORD in a list item", async () => {
    await using fixture = await mountVimComposer(LIST);
    await fixture.keys("<Esc>", "g", "g", "0", "v", "E");
    expect(fixture.painted().visual).toEqual(["Read"]);
    await fixture.keys("E", "E");
    expect(fixture.painted().visual).toEqual(["Read alpha beta."]);
  });

  it("x at an item's start deletes its first letter and keeps the list", async () => {
    await using fixture = await mountVimComposer("1. RMap alpha beta.\n2. Review gamma delta.");
    await fixture.keys("<Esc>", "g", "g", "0", "x");
    expect(fixture.prompt()).toBe("1. Map alpha beta.\n2. Review gamma delta.");
    expect(fixture.blocks()).toEqual(["orderedList"]);
    // A wide letter, so the cursor is a highlight rather than the narrow-glyph overlay.
    expect(fixture.painted().cursor, "the cursor is painted on the edited document").toBe("M");
  });

  it("dd on a list item removes the item, and on the last item removes the list", async () => {
    await using fixture = await mountVimComposer(`${LIST}\n\nAfter the list.`);
    expect(vimText(fixture)).toBe("Read alpha beta.\nReview gamma delta.\n\nAfter the list.");
    await fixture.keys("<Esc>", "g", "g", "d", "d");
    expect(vimText(fixture)).toBe("Review gamma delta.\n\nAfter the list.");
    expect(fixture.blocks()).toEqual(["orderedList", "paragraph", "paragraph"]);

    await fixture.keys("d", "d");
    expect(vimText(fixture)).toBe("\nAfter the list.");
    expect(fixture.blocks()).toEqual(["paragraph", "paragraph"]);
  });

  it("o in a list opens a sibling item, and what is typed lands in it", async () => {
    await using fixture = await mountVimComposer(LIST);
    await fixture.keys("<Esc>", "g", "g", "o");
    expect(composerSurface.mode()).toBe("insert");
    await fixture.type("NEW");
    expect(vimText(fixture)).toBe("Read alpha beta.\nNEW\nReview gamma delta.");
    expect(fixture.blocks()).toEqual(["orderedList"]);
  });

  it("O in a list opens an item above, and the cursor waits in it", async () => {
    await using fixture = await mountVimComposer(LIST);
    await fixture.keys("<Esc>", "g", "g", "O");
    await fixture.type("NEW");
    expect(vimText(fixture)).toBe("NEW\nRead alpha beta.\nReview gamma delta.");
    expect(fixture.blocks()).toEqual(["orderedList"]);
  });

  it("cw changes the word and keeps the blank after it, with no race into insert mode", async () => {
    await using fixture = await mountVimComposer("Read alpha beta.");
    await fixture.keys("<Esc>", "0", "c", "w");
    await fixture.type("NEW");
    expect(fixture.prompt()).toBe("NEW alpha beta.");
  });

  it("a task list reads as its tasks' text, without the checkbox labels", async () => {
    await using fixture = await mountVimComposer("- [ ] first task\n- [ ] second task");
    expect(vimText(fixture)).toBe("first task\nsecond task");
    await fixture.keys("<Esc>", "g", "g", "V");
    expect(fixture.painted().visual).toEqual(["first task"]);
  });

  it("a code block reads as its code lines, blank lines included, and dd keeps the block", async () => {
    await using fixture = await mountVimComposer("```js\nconst a = 1;\n\nlet b = 2;\n```");
    expect(vimText(fixture)).toBe("const a = 1;\n\nlet b = 2;");
    await fixture.keys("<Esc>", "g", "g", "0");
    expect(caretCharacter(fixture)).toBe("c");
    await fixture.keys("j", "j", "d", "d");
    expect(vimText(fixture)).toBe("const a = 1;\n");
    expect(fixture.blocks()).toEqual(["codeBlock"]);
  });

  it("flash with an uppercase pattern matches the shown text inside a list", async () => {
    await using fixture = await mountVimComposer("1. Read read Repeat ready.");
    await fixture.keys("<Esc>");
    composerSurface.runCommand?.("flash.jump", null);
    await fixture.keys("R", "e");
    expect([...(CSS.highlights.get("mesura-flash-match") ?? [])].map(String)).toEqual(["Re", "Re"]);
    await fixture.keys("<CR>");
    expect(caretCharacter(fixture)).toBe("R");
  });

  it("a chip deleted, undone, redone and pasted comes back as the same chip", async () => {
    await using fixture = await mountVimComposer("Read @AGENTS.md and @README.md now.");
    const chips = () => {
      let count = 0;
      fixture.editor().state.doc.descendants((node) => {
        if (node.type.name === "composer-mention") count += 1;
      });
      return count;
    };
    expect(chips()).toBe(2);
    await fixture.keys("<Esc>", "0", "w", "w", "w", "x");
    expect(fixture.prompt()).toBe("Read @AGENTS.md and  now.");
    await fixture.keys("u", "<C-r>", "p");
    expect(fixture.prompt()).not.toMatch(/[\u{e000}-\u{f8ff}]/u);
    expect(fixture.prompt()).toContain("@README.md");
    expect(chips()).toBe(2);
  });

  it("dd on a heading deletes the heading, even when the line below reads the same", async () => {
    await using fixture = await mountVimComposer("# same\nsame");
    expect(fixture.blocks()).toEqual(["heading", "paragraph"]);
    await fixture.keys("<Esc>", "g", "g", "d", "d");
    expect(fixture.blocks()).toEqual(["paragraph"]);
  });

  it("x deletes the character under the cursor, not an equal one beside it", async () => {
    await using fixture = await mountVimComposer("**a**a");
    await fixture.keys("<Esc>", "0");
    expect(vimText(fixture)).toBe("aa");
    expect(caretCharacter(fixture)).toBe("a");
    await fixture.keys("x");
    expect(fixture.prompt()).toBe("a");
    expect(textRuns(fixture)).toEqual([{ text: "a", marks: [] }]);

    await fixture.keys("u");
    expect(fixture.prompt()).toBe("**a**a");
    expect(vimText(fixture)).toBe("aa");
    expect(textRuns(fixture)).toEqual([
      { text: "a", marks: ["bold"] },
      { text: "a", marks: [] },
    ]);
    expect(caretCharacter(fixture)).toBe("a");

    await fixture.keys("<C-r>");
    expect(fixture.prompt()).toBe("a");
    expect(vimText(fixture)).toBe("a");
    expect(caretCharacter(fixture)).toBe("a");
  });

  it("x keeps the adjacent marked character when the equal plain character comes first", async () => {
    await using fixture = await mountVimComposer("a**a**");
    await fixture.keys("<Esc>", "0", "x");
    expect(fixture.prompt()).toBe("**a**");
    expect(vimText(fixture)).toBe("a");
    expect(textRuns(fixture)).toEqual([{ text: "a", marks: ["bold"] }]);
  });

  it("moves across styled text without revealing markers and restores source editing in insert", async () => {
    await using fixture = await mountVimComposer("**ab**cd");
    await fixture.keys("<Esc>", "0", "l");
    expect(vimText(fixture)).toBe("abcd");
    expect(caretCharacter(fixture)).toBe("b");
    await fixture.keys("l");
    expect(caretCharacter(fixture)).toBe("c");
    await fixture.keys("h", "i");
    expect(composerSurface.mode()).toBe("insert");
    expect(vimText(fixture)).toBe("**ab**cd");
    expect(caretCharacter(fixture)).toBe("b");
    await fixture.keys("<Esc>");
    expect(vimText(fixture)).toBe("abcd");
    expect(caretCharacter(fixture)).toBe("a");
  });

  it("keeps a list and its chip when x removes a styled character before the chip", async () => {
    await using fixture = await mountVimComposer("a @README.md now");
    const chips = () => {
      const nodes: string[] = [];
      fixture.editor().state.doc.descendants((node) => {
        if (node.type.name === "composer-mention") nodes.push(node.attrs.path);
      });
      return nodes;
    };
    const before = chips();
    expect(before).toHaveLength(1);
    await act(() => {
      fixture
        .editor()
        .chain()
        .toggleBulletList()
        .setTextSelection({ from: 3, to: 4 })
        .setBold()
        .run();
    });
    await fixture.keys("<Esc>", "g", "g", "0", "x");
    expect(fixture.prompt()).toBe("-  @README.md now");
    expect(fixture.blocks()).toEqual(["bulletList"]);
    expect(chips()).toEqual(before);
  });

  it("restores source editing when Vim resets while the cursor is inside styled text", async () => {
    await using fixture = await mountVimComposer("**ab**cd");
    await fixture.keys("<Esc>", "0", "l");
    await act(() => composerSurface.reset());
    expect(composerSurface.mode()).toBe("insert");
    expect(vimText(fixture)).toBe("**ab**cd");
    expect(caretCharacter(fixture)).toBe("b");
  });

  it("a yank survives an empty insert session", async () => {
    await using fixture = await mountVimComposer("Read alpha beta.");
    await fixture.keys("<Esc>", "0", "y", "w", "i", "<Esc>", "p");
    expect(fixture.prompt()).toBe("RRead ead alpha beta.");
  });
});
