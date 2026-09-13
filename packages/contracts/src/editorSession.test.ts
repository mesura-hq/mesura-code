import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  EditorSessionAttachInput,
  EditorSessionCloseInput,
  EditorSessionEvent,
  EditorSessionInputInput,
  EditorSessionOpenInput,
  EditorSessionReplaceTextInput,
  EditorSessionSetCursorInput,
  EditorSessionSnapshot,
  EditorSessionViewportInput,
} from "./editorSession.ts";

/**
 * The editor session's wire shape.
 *
 * Every bound here is a refusal the server would otherwise have to make later,
 * with a worse error and after doing work. The caps matter more than they look:
 * an editor session carries whole files and whole screens, so an unbounded
 * field is an unbounded message on a link that may be a phone on mobile data.
 */

const decodeOpen = Schema.decodeUnknownSync(EditorSessionOpenInput);
const decodeAttach = Schema.decodeUnknownSync(EditorSessionAttachInput);
const decodeInput = Schema.decodeUnknownSync(EditorSessionInputInput);
const decodeViewport = Schema.decodeUnknownSync(EditorSessionViewportInput);
const decodeSetCursor = Schema.decodeUnknownSync(EditorSessionSetCursorInput);
const decodeReplaceText = Schema.decodeUnknownSync(EditorSessionReplaceTextInput);
const decodeClose = Schema.decodeUnknownSync(EditorSessionCloseInput);
const decodeEvent = Schema.decodeUnknownSync(EditorSessionEvent);
const decodeSnapshot = Schema.decodeUnknownSync(EditorSessionSnapshot);

describe("EditorSession inputs", () => {
  it("decodes an open with a file's lines", () => {
    const open = decodeOpen({
      threadId: "  thread-1  ",
      cwd: "/srv/project",
      relativePath: "src/main.ts",
      lines: ["const a = 1;", ""],
    });
    expect(open.threadId).toBe("thread-1");
    expect(open.relativePath).toBe("src/main.ts");
    expect(open.lines).toEqual(["const a = 1;", ""]);
  });

  it("refuses an open with more lines than the read path can ever produce", () => {
    // The file read truncates at a megabyte, and a truncated file never reaches
    // the editor at all, so a hundred thousand lines is already unreachable.
    expect(() =>
      decodeOpen({
        threadId: "thread-1",
        cwd: "/srv/project",
        relativePath: "src/main.ts",
        lines: Array.from({ length: 100_001 }, () => ""),
      }),
    ).toThrow();
  });

  it("refuses an open with no thread", () => {
    expect(() =>
      decodeOpen({ threadId: "   ", cwd: "/srv/project", relativePath: "a.ts", lines: [] }),
    ).toThrow();
  });

  it("decodes an attach", () => {
    expect(decodeAttach({ threadId: "thread-1" }).threadId).toBe("thread-1");
  });

  it("decodes keys in Neovim notation and caps their length", () => {
    expect(decodeInput({ threadId: "thread-1", keys: "<C-w>v" }).keys).toBe("<C-w>v");
    expect(() => decodeInput({ threadId: "thread-1", keys: "x".repeat(1025) })).toThrow();
  });

  it("decodes a viewport and refuses one that starts above the first line", () => {
    const viewport = decodeViewport({ threadId: "thread-1", topline: 1, rows: 40, cols: 120 });
    expect(viewport.topline).toBe(1);
    expect(() =>
      decodeViewport({ threadId: "thread-1", topline: 0, rows: 40, cols: 120 }),
    ).toThrow();
    expect(() =>
      decodeViewport({ threadId: "thread-1", topline: 1, rows: 501, cols: 120 }),
    ).toThrow();
  });

  it("decodes a cursor", () => {
    const cursor = decodeSetCursor({ threadId: "thread-1", line: 12, col: 3 });
    expect(cursor).toEqual({ threadId: "thread-1", line: 12, col: 3 });
  });

  it("decodes a text replacement and caps the number of edits", () => {
    const replace = decodeReplaceText({
      threadId: "thread-1",
      edits: [{ startLine: 1, startCol: 1, endLine: 1, endCol: 4, text: "new" }],
    });
    expect(replace.edits).toHaveLength(1);
    expect(() =>
      decodeReplaceText({
        threadId: "thread-1",
        edits: Array.from({ length: 1001 }, () => ({
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 1,
          text: "",
        })),
      }),
    ).toThrow();
  });

  it("decodes a close", () => {
    expect(decodeClose({ threadId: "thread-1" }).threadId).toBe("thread-1");
  });
});

describe("EditorSessionEvent", () => {
  const snapshot = {
    relativePath: "src/main.ts",
    lines: ["const a = 1;"],
    cursor: { line: 1, col: 1 },
    mode: "n",
    topline: 1,
    hlDefs: { "1": { fg: 16711680, bold: true, groups: ["Search"] } },
  };

  it("decodes a snapshot on its own", () => {
    expect(decodeSnapshot(snapshot).relativePath).toBe("src/main.ts");
  });

  it.each([
    ["snapshot", { type: "snapshot", snapshot }],
    ["lines", { type: "lines", first: 0, last: 1, lines: ["changed"] }],
    ["cursor", { type: "cursor", line: 3, col: 7 }],
    ["mode", { type: "mode", mode: "i", blocking: false }],
    ["viewport", { type: "viewport", topline: 1, botline: 40 }],
    [
      "decorations",
      {
        type: "decorations",
        overlays: [{ line: 1, col: 2, text: "a", hl: 3 }],
        highlightRuns: [{ line: 1, startCol: 1, endCol: 5, hl: 4 }],
        rows: [1, 2],
      },
    ],
    ["hlDefs", { type: "hlDefs", hlDefs: { "2": { bg: 255, groups: [] } } }],
    ["cmdline", { type: "cmdline", cmdline: { content: ":w", pos: 2, firstc: ":", prompt: "" } }],
    ["cmdline cleared", { type: "cmdline", cmdline: null }],
    ["message", { type: "message", kind: "echo", text: "written" }],
    ["writeRequested", { type: "writeRequested", relativePath: "src/main.ts" }],
    ["exited", { type: "exited", code: 0 }],
  ])("decodes a %s event", (_name, event) => {
    expect(decodeEvent(event).type).toBe((event as { type: string }).type);
  });

  it("refuses an event whose type is not one of the known ones", () => {
    expect(() => decodeEvent({ type: "nonsense" })).toThrow();
  });
});
