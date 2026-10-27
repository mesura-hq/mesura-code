import type { EditorSessionEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyEditorSessionEvent, EMPTY_EDITOR_SESSION_STATE } from "./editorSessionFold.ts";
import recorded from "./editorSessionFold.recorded.json";

/**
 * Events recorded from `EditorSessionManager.attachEventStream` over a real Neovim (the
 * fixture's `source` names the keys). How events are grouped into stream chunks must not
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
