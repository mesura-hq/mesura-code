import { createInitialContext, processKeystroke, TextBuffer } from "@vimee/core";
import { describe, expect, it } from "vite-plus/test";

// Pins `patches/@vimee__core@0.3.0.patch` against Neovim's results on the same text.
function run(text: string, keys: readonly string[]) {
  const buffer = new TextBuffer(text);
  let context = createInitialContext({ line: 0, col: 0 });
  for (const key of keys) context = processKeystroke(key, context, buffer, false, false).newCtx;
  return { text: buffer.getContent(), col: context.cursor.col, mode: context.mode };
}

describe("Vim grammar patched into @vimee/core", () => {
  it("E moves to the end of a whitespace-delimited WORD, with a count", () => {
    expect(run("foo.bar baz qux", ["E"]).col).toBe(6);
    expect(run("foo.bar baz qux", ["2", "E"]).col).toBe(10);
  });

  it("E works in visual mode and as an operator motion", () => {
    expect(run("foo.bar baz qux", ["v", "E", "d"]).text).toBe(" baz qux");
    expect(run("foo.bar baz qux", ["d", "E"]).text).toBe(" baz qux");
  });

  it("cw on a word changes to the word's end and keeps the following blank", () => {
    expect(run("Read alpha beta", ["c", "w"])).toMatchObject({
      text: " alpha beta",
      mode: "insert",
    });
    expect(run("ab cd", ["l", "c", "w"]).text).toBe("a cd");
    expect(run("aa bb cc", ["2", "c", "w"]).text).toBe(" cc");
    expect(run("a.b cd", ["c", "W"]).text).toBe(" cd");
  });

  it("cw on blanks and dw keep Vim's ordinary word range", () => {
    expect(run("a  b", ["l", "c", "w"]).text).toBe("ab");
    expect(run("Read alpha beta", ["d", "w"]).text).toBe("alpha beta");
  });
});
