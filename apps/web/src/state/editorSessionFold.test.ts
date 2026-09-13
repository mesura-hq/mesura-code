import type { EditorSessionEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyEditorSessionEvent,
  applyLinesEvent,
  EMPTY_EDITOR_SESSION_STATE,
  type EditorSessionState,
} from "./editorSessionFold.ts";

/**
 * Folding a thread's editor session into the state the driver reconciles to.
 *
 * The property that matters here is not that one event is applied correctly.
 * It is that **the state after N events does not depend on how many renders
 * happened in between.** A fold that kept only the last event had that
 * property for one event and lost it for two, which is the shape of every
 * silent corruption this file exists to prevent: the render is coalesced, the
 * first delta is never applied, and every later delta is then measured against
 * text that has drifted.
 */

const fold = (state: EditorSessionState, events: ReadonlyArray<EditorSessionEvent>) =>
  events.reduce(applyEditorSessionEvent, state);

const snapshot = (lines: ReadonlyArray<string>): EditorSessionEvent => ({
  type: "snapshot",
  snapshot: {
    relativePath: "src/a.ts",
    lines,
    cursor: { line: 1, col: 1 },
    mode: "n",
    topline: 1,
    hlDefs: {},
  },
});

const linesEvent = (
  first: number,
  last: number,
  lines: ReadonlyArray<string>,
): EditorSessionEvent => ({ type: "lines", first, last, lines });

describe("applyLinesEvent", () => {
  it("replaces the half-open range Neovim names", () => {
    expect(applyLinesEvent(["one", "two", "three"], { first: 1, last: 2, lines: ["TWO"] })).toEqual(
      ["one", "TWO", "three"],
    );
  });

  it("takes the whole buffer when Neovim sends -1", () => {
    expect(applyLinesEvent(["one"], { first: 0, last: -1, lines: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("deletes a range", () => {
    expect(applyLinesEvent(["one", "two", "three"], { first: 0, last: 2, lines: [] })).toEqual([
      "three",
    ]);
  });

  it("appends past the last line", () => {
    expect(applyLinesEvent(["one"], { first: 1, last: 1, lines: ["two"] })).toEqual(["one", "two"]);
  });

  it("leaves the one empty line Neovim keeps when everything is deleted", () => {
    // Measured: `gg` `dG` on a three-line buffer sends this event, and
    // `nvim_buf_get_lines` then answers `[""]`, never `[]`. A fold that
    // produced `[]` would hand the reconcile a buffer neither Neovim nor
    // Monaco can hold.
    expect(applyLinesEvent(["one", "two", "three"], { first: 0, last: 3, lines: [] })).toEqual([
      "",
    ]);
    expect(applyLinesEvent(["one"], { first: 0, last: -1, lines: [] })).toEqual([""]);
  });

  it("does not change the lines it was given", () => {
    const before = ["one", "two"];
    applyLinesEvent(before, { first: 0, last: 1, lines: ["ONE"] });
    expect(before).toEqual(["one", "two"]);
  });
});

describe("applyEditorSessionEvent", () => {
  it("takes the file, the text, the cursor and the mode from a snapshot", () => {
    const state = applyEditorSessionEvent(EMPTY_EDITOR_SESSION_STATE, snapshot(["one", "two"]));
    expect(state.relativePath).toBe("src/a.ts");
    expect(state.lines).toEqual(["one", "two"]);
    expect(state.cursor).toEqual({ line: 1, col: 1 });
    expect(state.mode).toBe("n");
    expect(state.sequence).toBe(1);
  });

  it("keeps the text itself, so no render can be too slow to see an event", () => {
    // The guard for the defect this fold was rewritten to remove: two line
    // events land between two renders, the component is rendered once, and the
    // first event must already be in the state it renders.
    const state = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one", "two", "three"]),
      linesEvent(0, 1, ["ONE"]),
      linesEvent(2, 3, ["THREE"]),
    ]);
    expect(state.lines).toEqual(["ONE", "two", "THREE"]);
    expect(state.sequence).toBe(3);
  });

  it("reaches the same text however the events were batched", () => {
    const events = [
      snapshot(["a", "b", "c"]),
      linesEvent(1, 2, ["B"]),
      linesEvent(3, 3, ["d"]),
      linesEvent(0, 1, []),
    ];
    const all = fold(EMPTY_EDITOR_SESSION_STATE, events);
    const inTwoHalves = fold(fold(EMPTY_EDITOR_SESSION_STATE, events.slice(0, 2)), events.slice(2));
    expect(all.lines).toEqual(inTwoHalves.lines);
    expect(all.lines).toEqual(["B", "c", "d"]);
  });

  it("a later snapshot replaces the file, not just the text", () => {
    const state = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one"]),
      linesEvent(1, 1, ["two"]),
      {
        type: "snapshot",
        snapshot: {
          relativePath: "src/b.ts",
          lines: ["other"],
          cursor: { line: 1, col: 1 },
          mode: "n",
          topline: 1,
          hlDefs: {},
        },
      },
    ]);
    expect(state.relativePath).toBe("src/b.ts");
    expect(state.lines).toEqual(["other"]);
  });

  it("follows the cursor, the mode and the viewport", () => {
    const state = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one", "two"]),
      { type: "cursor", line: 2, col: 3 },
      { type: "mode", mode: "i", blocking: false },
      { type: "viewport", topline: 2, botline: 2 },
    ]);
    expect(state.cursor).toEqual({ line: 2, col: 3 });
    expect(state.mode).toBe("i");
    expect(state.topline).toBe(2);
  });

  it("follows the command line and clears it again", () => {
    const shown = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one"]),
      { type: "cmdline", cmdline: { content: "noh", pos: 3, firstc: ":", prompt: "" } },
    ]);
    expect(shown.cmdline?.content).toBe("noh");
    expect(shown.cmdline?.firstc).toBe(":");

    const hidden = applyEditorSessionEvent(shown, { type: "cmdline", cmdline: null });
    expect(hidden.cmdline).toBeNull();
  });

  it("keeps the last message, and drops an empty one", () => {
    const shown = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one"]),
      { type: "message", kind: "emsg", text: "E492: Not an editor command" },
    ]);
    expect(shown.message).toEqual({ kind: "emsg", text: "E492: Not an editor command" });

    // `msg_clear` arrives as an empty message rather than as its own event.
    const cleared = applyEditorSessionEvent(shown, { type: "message", kind: "", text: "" });
    expect(cleared.message).toBeNull();
  });

  it("clears a message when the command line closes", () => {
    // An error from the last command still on screen under the next one reads
    // as that command having failed too.
    const withError = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one"]),
      { type: "message", kind: "emsg", text: "E492" },
    ]);
    const afterClose = applyEditorSessionEvent(withError, { type: "cmdline", cmdline: null });
    expect(afterClose.message).toBeNull();
  });

  it("counts an event that changes nothing else", () => {
    // The sequence is what tells a component something arrived. An event this
    // fold has no field for still has to move it, or a message the driver does
    // care about could be the one that never triggers a render.
    const before = applyEditorSessionEvent(EMPTY_EDITOR_SESSION_STATE, snapshot(["one"]));
    const after = applyEditorSessionEvent(before, {
      type: "message",
      kind: "echo",
      text: "written",
    });
    expect(after.sequence).toBe(before.sequence + 1);
    expect(after.lines).toEqual(["one"]);
    expect(after.latestEvent?.type).toBe("message");
  });
});
