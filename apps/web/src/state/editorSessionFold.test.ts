import type { EditorSessionEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyEditorSessionEvent,
  applyLinesEvent,
  EMPTY_EDITOR_SESSION_STATE,
  type EditorSessionState,
} from "./editorSessionFold.ts";
import { widgetsFor } from "../components/files/monaco/nvim/nvimDecorations.ts";

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
    relativePath: THE_OPEN_FILE,
    lines,
    cursor: { line: 1, col: 1 },
    mode: "n",
    topline: 1,
    hlDefs: {},
  },
});

/** The file every event in this file belongs to, unless one says otherwise. */
const THE_OPEN_FILE = "src/a.ts";

const linesEvent = (
  first: number,
  last: number,
  lines: ReadonlyArray<string>,
  relativePath: string = THE_OPEN_FILE,
): EditorSessionEvent => ({ type: "lines", relativePath, first, last, lines });

describe("a delta that names another file", () => {
  it("is refused rather than applied", () => {
    // The defect this prevents, end to end: a change belonging to one file is
    // applied to the text of another, the panel renders the result as the open
    // file, and the save writes it to disk. It happened three times by three
    // different routes, which is why the check is here — at the one place that
    // does not have to know which route produced it.
    const state = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one", "two", "three"]),
      linesEvent(0, 1, ["WRONG"], "src/somewhere-else.ts"),
    ]);

    expect(state.lines).toEqual(["one", "two", "three"]);
  });

  it("still counts as something having happened", () => {
    // `sequence` advances so the driver treats it as a frame it cannot
    // account for and reconciles in full against `lines` — which is unchanged
    // and therefore still the truth. Holding the sequence back would leave the
    // driver believing it is up to date.
    const before = fold(EMPTY_EDITOR_SESSION_STATE, [snapshot(["one"])]);
    const after = applyEditorSessionEvent(before, linesEvent(0, 1, ["WRONG"], "other.ts"));

    expect(after.sequence).toBe(before.sequence + 1);
  });

  it("is refused before any file is open", () => {
    // Nothing to compare against and nothing to apply a delta to.
    const state = applyEditorSessionEvent(EMPTY_EDITOR_SESSION_STATE, linesEvent(0, 1, ["WRONG"]));

    expect(state.lines).toEqual([]);
  });
});

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

  it("draws what Neovim drew, and keeps the rows an event did not name", () => {
    // The guard for a defect that shipped once and was invisible: the three
    // events this phase added fell through to the default branch, so every
    // flash label, every search highlight and every selection was dropped on
    // the way to the screen while the suite stayed green.
    const state = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one", "two", "three"]),
      {
        type: "decorations",
        overlays: [{ line: 1, col: 2, text: "a", hl: 7 }],
        highlightRuns: [],
        rows: [1],
      },
      {
        type: "decorations",
        overlays: [{ line: 3, col: 1, text: "b", hl: 7 }],
        highlightRuns: [],
        rows: [3],
      },
    ]);
    expect([...widgetsFor(state.decorations).values()].map((widget) => widget.text).sort()).toEqual(
      ["a", "b"],
    );
  });

  it("keeps the colours a drawing refers to", () => {
    const state = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one"]),
      { type: "hlDefs", hlDefs: { "7": { fg: 0xff0000, groups: ["Search"] } } },
      { type: "hlDefs", hlDefs: { "8": { bg: 0x00ff00, groups: [] } } },
    ]);
    expect(Object.keys(state.hlDefs).sort()).toEqual(["7", "8"]);
    expect(state.hlDefs["7"]?.fg).toBe(0xff0000);
  });

  it("follows the selection into and out of visual mode", () => {
    const selected = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one", "two"]),
      {
        type: "visual",
        visual: { anchor: { line: 1, col: 1 }, cursor: { line: 2, col: 3 }, kind: "v" },
      },
    ]);
    expect(selected.visual?.cursor).toEqual({ line: 2, col: 3 });

    const cleared = applyEditorSessionEvent(selected, { type: "visual", visual: null });
    expect(cleared.visual).toBeNull();
  });

  it("drops everything drawn over the file it just left", () => {
    const drawn = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one"]),
      {
        type: "decorations",
        overlays: [{ line: 1, col: 1, text: "a", hl: 7 }],
        highlightRuns: [],
        rows: [1],
      },
    ]);
    const switched = applyEditorSessionEvent(drawn, {
      type: "snapshot",
      snapshot: {
        relativePath: "src/b.ts",
        lines: ["other"],
        cursor: { line: 1, col: 1 },
        mode: "n",
        topline: 1,
        hlDefs: {},
      },
    });
    expect([...widgetsFor(switched.decorations).values()]).toEqual([]);
  });

  it("counts every write Neovim asks for, even when another event lands with it", () => {
    // `:w` produces a write request and then, in the same burst, the redraw
    // and the command line closing. A consumer reading the latest event sees
    // one of those instead and never flushes the save — and the developer has
    // already been told the file was written.
    const state = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one"]),
      { type: "writeRequested", relativePath: "src/a.ts" },
      { type: "cmdline", cmdline: null },
      { type: "cursor", line: 1, col: 1 },
    ]);
    expect(state.writeRequests).toBe(1);
    expect(state.latestEvent?.type).toBe("cursor");

    const twice = applyEditorSessionEvent(state, {
      type: "writeRequested",
      relativePath: "src/a.ts",
    });
    expect(twice.writeRequests).toBe(2);
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

describe("flash's jump", () => {
  it("is on while a mode event says so, and off with the next one that does not", () => {
    // Neovim's own mode stays `n` throughout a flash jump, so the flag is the
    // only thing that tells the strip the next key picks a label.
    const jumping = fold(EMPTY_EDITOR_SESSION_STATE, [
      snapshot(["one"]),
      { type: "mode", mode: "n", blocking: false, jumping: true },
    ]);
    expect(jumping.jumping).toBe(true);
    const done = applyEditorSessionEvent(jumping, { type: "mode", mode: "n", blocking: false });
    expect(done.jumping).toBe(false);
  });
});
