import type { EditorSessionEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyEditorSessionEvent, EMPTY_EDITOR_SESSION_STATE } from "./editorSessionFold.ts";
import recorded from "./editorSessionFold.recorded.json";

/**
 * Guard: the attach fold gives the same state for a recorded event sequence.
 *
 * The events were recorded from `EditorSessionManager.attachEventStream` over
 * a real Neovim (`source` in the fixture names the keys). The expected steps
 * are what this fold produced for them at the base of the editor latency
 * cycle, which changes how events are grouped into stream chunks and must not
 * change what they fold to.
 */

const events = recorded.events as ReadonlyArray<EditorSessionEvent>;

describe("the attach fold over a recorded Neovim session", () => {
  it("folds the recorded attach events to the recorded states, step by step", () => {
    let state = EMPTY_EDITOR_SESSION_STATE;
    const steps = events.map((event) => {
      state = applyEditorSessionEvent(state, event);
      return {
        sequence: state.sequence,
        relativePath: state.relativePath,
        lines: state.lines,
        cursor: state.cursor,
        mode: state.mode,
        jumping: state.jumping,
        topline: state.topline,
        cmdline: state.cmdline,
        message: state.message,
        visual: state.visual,
        writeRequests: state.writeRequests,
        ended: state.ended,
        latestEvent: state.latestEvent?.type ?? null,
        decorationRows: [...state.decorations.rows.keys()],
        hlDefIds: Object.keys(state.hlDefs).length,
      };
    });

    expect(steps).toEqual(recorded.steps);
    expect(JSON.parse(JSON.stringify([...state.decorations.rows]))).toEqual(
      recorded.finalDecorations.rows,
    );
  });
});
