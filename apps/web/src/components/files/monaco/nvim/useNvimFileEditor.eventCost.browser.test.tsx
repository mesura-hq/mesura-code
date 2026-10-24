import { act } from "../../../../../test/render";
/**
 * Entry point: `useNvimFileEditor`, the hook `MonacoFileSurface` mounts for
 * modal editing, rendered under React with a model, over an editor that lays
 * that model out (`HarnessLayout` in `~/test/nvimEditorHarness.tsx`). Neovim's
 * answers arrive on the real attach subscription, folded by the real
 * `editorSessionFold`, and reach Monaco through the real `useNvimDriver`.
 *
 * Phase 4 of the editor latency cycle ("One key costs one small render"):
 *
 * - Criterion 1: a cursor event from Neovim is applied to Monaco without
 *   waiting for a passive React effect. Measured here as React commits: the
 *   caret is on the new line, and the line is in view, before React commits
 *   anything for the event. A passive effect runs only after a commit, so a
 *   cursor applied there is applied one commit late. The investigation
 *   measured that path at about 160 ms on the real client when the cursor
 *   leaves the visible lines (`/tmp/editor-perf/repro/`).
 * - Criterion 4: events that change no text — cursor, mode, decorations,
 *   messages — do not read or diff the whole Monaco model. Counted on the
 *   model: `getLinesContent` and `getValue` are the whole-model reads.
 */
import { Profiler } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => () => import("~/test/nvimEditorHarness"));
vi.mock("~/connection/runtime", async () => (await harness()).mockConnectionRuntime());
vi.mock("~/state/server", async () => (await harness()).mockServerState());
vi.mock("monaco-editor", async () => (await harness()).mockMonacoEditor());

import type { EditorSessionEvent } from "@t3tools/contracts";

import {
  HARNESS_ENVIRONMENT_ID,
  HARNESS_RELATIVE_PATH,
  editorTransport,
  flushHarness,
  harnessThreadRef,
  makeHarnessModel,
  mountNvimEditor,
  recordEditorCalls,
  settleUntil,
  waitForReal,
  type HarnessModel,
  type RecordedEditorCall,
} from "~/test/nvimEditorHarness";
import { monacoFileModelKey } from "../monacoFileModels";
import { useNvimFileEditor } from "./useNvimFileEditor";

const CWD = "/harness/project";
const EXTERNAL_EDITS = { isApplying: () => false, run: (body: () => void) => body() };
const NO_SAVE = () => {};

/** 200 short lines: at 20 px a row and 300 px tall, Monaco shows lines 1 to 15. */
const LINES = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
const LAYOUT_ROWS = { wrapColumn: 180, lineHeight: 20, height: 300 } as const;

/**
 * The harness model, with its whole-model reads counted.
 *
 * `getLinesContent` and `getValue` are the two calls that copy every line;
 * `getLineContent` and `getLineCount` stay free, because reading the lines an
 * event names is what an incremental apply is.
 */
function countingModel(lines: ReadonlyArray<string>) {
  const model = makeHarnessModel(
    lines,
    monacoFileModelKey(HARNESS_ENVIRONMENT_ID, CWD, HARNESS_RELATIVE_PATH),
  );
  const reads = { getLinesContent: 0, getValue: 0 };
  const counted: HarnessModel = {
    ...model,
    getLinesContent: () => {
      reads.getLinesContent += 1;
      return model.getLinesContent();
    },
    getValue: () => {
      reads.getValue += 1;
      return model.getValue();
    },
  };
  return {
    model: counted,
    reads,
    resetReads: () => {
      reads.getLinesContent = 0;
      reads.getValue = 0;
    },
  };
}

function EditorUnderTest(props: { readonly editor: unknown; readonly model: HarnessModel }) {
  useNvimFileEditor({
    editor: props.editor as Parameters<typeof useNvimFileEditor>[0]["editor"],
    model: props.model as unknown as Parameters<typeof useNvimFileEditor>[0]["model"],
    environmentId: HARNESS_ENVIRONMENT_ID,
    threadRef: harnessThreadRef,
    cwd: CWD,
    relativePath: HARNESS_RELATIVE_PATH,
    enabled: true,
    externalEdits: EXTERNAL_EDITS,
    flushSave: NO_SAVE,
  });
  return null;
}

let mounted: Awaited<ReturnType<typeof mountNvimEditor>> | undefined;

async function setupBrowserFixture0() {

  editorTransport.reset();

return {async [Symbol.asyncDispose]() {

  editorTransport.autoReplyAll();
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();

}};
}



/**
 * Mounts the hook inside a `Profiler`, over an editor whose every call is
 * stamped with the number of React commits so far.
 *
 * The stamp is what tells a cursor applied as the event arrives from one
 * applied after React rendered for it: `Profiler.onRender` runs in the commit,
 * after the layout effects and before the passive ones.
 */
async function mountProfiled(model: HarnessModel) {
  let commits = 0;
  let recorder: ReturnType<typeof recordEditorCalls> | null = null;
  mounted = await mountNvimEditor({
    renderEditor: (editor) => {
      recorder ??= recordEditorCalls(editor, () => commits);
      return (
        <Profiler
          id="nvim-editor-under-test"
          onRender={() => {
            commits += 1;
          }}
        >
          <EditorUnderTest editor={recorder.editor} model={model} />
        </Profiler>
      );
    },
    layout: { model, ...LAYOUT_ROWS },
  });
  if (recorder === null) throw new Error("the editor was never rendered");
  const { calls, afterCall } = recorder as ReturnType<typeof recordEditorCalls>;
  // The open, the snapshot and the first viewport: the driver has reconciled
  // once and the editor is at rest.
  await waitForReal(
    () => editorTransport.viewports().length > 0,
    2000,
    "the client sends its first viewport",
  );
  await flushHarness();
  return {
    commits: () => commits,
    calls,
    afterCall,
  };
}

const isPositionCall =
  (line: number) =>
  (call: RecordedEditorCall): boolean =>
    call.method === "setPosition" &&
    (call.args[0] as { lineNumber?: number } | undefined)?.lineNumber === line;

describe("a cursor event from Neovim reaches Monaco as it arrives (phase 4, criterion 1)", () => {
  it("puts Monaco's caret on Neovim's line before React commits anything for the cursor event", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { model } = countingModel(LINES);
    editorTransport.setSnapshot({ lines: LINES, cursor: { line: 1, col: 1 }, topline: 1 });
    const profiled = await mountProfiled(model);

    const commitsBefore = profiled.commits();
    const from = profiled.calls.length;
    await act(async () => {
      editorTransport.emit({ type: "cursor", line: 2, col: 1 });
    });
    await settleUntil(
      () => profiled.calls.slice(from).some(isPositionCall(2)),
      "Monaco's caret moves to line 2",
    );

    const applied = profiled.calls.slice(from).find(isPositionCall(2));
    expect(
      applied?.stamp,
      "React commits counted when setPosition(line 2) ran; equal to the count before the event means it ran as the event arrived",
    ).toBe(commitsBefore);
  });

  it("scrolls a cursor that left the visible lines into view before React commits anything for it", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { model } = countingModel(LINES);
    editorTransport.setSnapshot({ lines: LINES, cursor: { line: 15, col: 1 }, topline: 1 });
    const profiled = await mountProfiled(model);
    const shown = mounted?.visibleRange();
    expect(shown?.endLineNumber, "precondition: Monaco shows lines 1 to 15").toBe(15);

    // `j` from the last visible line: Neovim's cursor is now below the window.
    const commitsBefore = profiled.commits();
    const from = profiled.calls.length;
    // Stamped by the first editor call after which line 16 is in view.
    let shownAtCommits: number | null = null;
    profiled.afterCall.add((commits) => {
      if (shownAtCommits === null && mounted?.showsPosition(16, 1) === true) {
        shownAtCommits = commits;
      }
    });
    await act(async () => {
      editorTransport.emit({ type: "cursor", line: 16, col: 1 });
    });
    await settleUntil(() => shownAtCommits !== null, "line 16 scrolls into view");

    const applied = profiled.calls.slice(from).find(isPositionCall(16));
    expect(applied?.stamp, "React commits counted when setPosition(line 16) ran").toBe(
      commitsBefore,
    );
    expect(shownAtCommits, "React commits counted when line 16 was scrolled into view").toBe(
      commitsBefore,
    );
  });
});

describe("events that change no text leave the whole model alone (phase 4, criterion 4)", () => {
  const TEXTLESS_EVENTS: ReadonlyArray<readonly [string, EditorSessionEvent]> = [
    ["cursor", { type: "cursor", line: 3, col: 2 }],
    ["mode", { type: "mode", mode: "i", blocking: false }],
    [
      "decorations",
      {
        type: "decorations",
        overlays: [{ line: 4, col: 1, text: "a", hl: 7 }],
        highlightRuns: [{ line: 5, startCol: 1, endCol: 3, hl: 7 }],
        rows: [4, 5],
      },
    ],
    ["message", { type: "message", kind: "echo", text: "written" }],
  ];

  it.each(TEXTLESS_EVENTS)(
    "reads no whole model for a lone %s event after the editor reconciled",
    async (name, event) => {
await using _browserFixture0 = await setupBrowserFixture0();

      const counting = countingModel(LINES);
      editorTransport.setSnapshot({ lines: LINES, cursor: { line: 1, col: 1 }, topline: 1 });
      await mountProfiled(counting.model);
      counting.resetReads();

      await act(async () => {
        editorTransport.emit(event);
      });
      await flushHarness();

      expect({ ...counting.reads }, `whole-model reads caused by one ${name} event`).toEqual({
        getLinesContent: 0,
        getValue: 0,
      });
    },
  );

  it("reads no whole model across a burst of cursor, mode, decoration and message events", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const counting = countingModel(LINES);
    editorTransport.setSnapshot({ lines: LINES, cursor: { line: 1, col: 1 }, topline: 1 });
    await mountProfiled(counting.model);
    counting.resetReads();

    // The shape of one `j` in a plugin-heavy config: the cursor, a redraw of
    // the decorations under it, the mode echo and a message, delivered as one
    // chunk so React may see them in one render.
    await act(async () => {
      editorTransport.emit(...TEXTLESS_EVENTS.map(([, event]) => event));
    });
    await flushHarness();

    expect({ ...counting.reads }, "whole-model reads caused by four text-free events").toEqual({
      getLinesContent: 0,
      getValue: 0,
    });
  });
});
