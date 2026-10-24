import { act, fakeTimers } from "../../../../../test/render";
/**
 * Entry point: `useNvimFileEditor`, the hook `MonacoFileSurface` mounts for
 * modal editing, rendered under React with a model, over an editor that lays
 * that model out with word wrap on (`HarnessLayout` in
 * `~/test/nvimEditorHarness.tsx`). Keys enter through the editor's
 * `onKeyDown`; Neovim's answers arrive on the real attach subscription; the
 * window the client asks Neovim for leaves through the real
 * `editorSession.viewport` command.
 *
 * Phase 2 of the editor latency cycle, criterion 6, the client's half:
 * viewport requests never move Neovim's cursor away from where keys put it.
 * The server clamps the cursor into the window a viewport request names
 * (`SET_VIEWPORT_LUA`), so a request whose window leaves out the line Neovim's
 * cursor is on moves that cursor. The bench recorded exactly that on its
 * Markdown fixture: `j` put the cursor on line 8, Neovim scrolled to topline
 * 2, the client followed topline 2, word wrap left Monaco showing lines 2 to 7
 * only, and the client asked for `topline 2, rows 6` — which pulled the cursor
 * back to line 7. Fifty `j` from the top ended on line 41.
 *
 * The server's half, the same run replayed against a real Neovim, is in
 * `apps/server/src/editor/conformance/longLines.test.ts`.
 */
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => () => import("~/test/nvimEditorHarness"));
vi.mock("~/connection/runtime", async () => (await harness()).mockConnectionRuntime());
vi.mock("~/state/server", async () => (await harness()).mockServerState());
vi.mock("monaco-editor", async () => (await harness()).mockMonacoEditor());

import {
  HARNESS_ENVIRONMENT_ID,
  HARNESS_RELATIVE_PATH,
  editorTransport,
  harnessThreadRef,
  makeHarnessModel,
  mountNvimEditor,
  printable,
  waitForReal,
  type HarnessModel,
} from "~/test/nvimEditorHarness";
import { monacoFileModelKey } from "../monacoFileModels";
import { useNvimFileEditor } from "./useNvimFileEditor";

const CWD = "/harness/project";
const EXTERNAL_EDITS = { isApplying: () => false, run: (body: () => void) => body() };
const NO_SAVE = () => {};

/**
 * The top of the bench's Markdown fixture, in shape: a title, then paragraphs
 * of several hundred characters between blank lines. At 180 columns a
 * paragraph wraps to four rows, so Monaco shows far fewer lines than Neovim,
 * which never wraps, shows in a window of the same number of rows.
 */
const LINES = [
  "# Long-line Markdown fixture",
  "",
  ...Array.from({ length: 40 }, (_, index) =>
    index % 2 === 0 ? `Paragraph ${index / 2 + 1} ${"x".repeat(640)}` : "",
  ),
];

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

/** Advances the viewport coalescer on the test clock. */
const nextFrames = () => act(() => vi.advanceTimersToNextFrame());

async function setupBrowserFixture0() {
  editorTransport.reset();

  return {
    async [Symbol.asyncDispose]() {
      editorTransport.autoReplyAll();
      await mounted?.unmount();
      mounted = undefined;
      vi.unstubAllGlobals();
    },
  };
}

describe("the window the client asks Neovim for, with word wrap on", () => {
  it("never sends Neovim a window that leaves out the line a key put its cursor on", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    using _timers = fakeTimers();

    const model = makeHarnessModel(
      LINES,
      monacoFileModelKey(HARNESS_ENVIRONMENT_ID, CWD, HARNESS_RELATIVE_PATH),
    );
    editorTransport.setSnapshot({ lines: LINES, cursor: { line: 1, col: 1 }, topline: 1 });
    // 14 rows of 20 px: the title, a blank, a paragraph (4 rows), a blank, a
    // paragraph, a blank and the top of a third paragraph — lines 1 to 7.
    mounted = await mountNvimEditor({
      renderEditor: (editor) => <EditorUnderTest editor={editor} model={model} />,
      layout: { model, wrapColumn: 180, lineHeight: 20, height: 280 },
    });
    await waitForReal(
      () => editorTransport.viewports().length > 0,
      2000,
      "the client sends its first viewport",
    );
    const neovimRows = editorTransport.viewports().at(-1)?.rows ?? 0;
    expect(neovimRows, "precondition: Monaco shows lines 1 to 7").toBe(7);

    // Seven `j` from line 1, each answered the way Neovim answers it: the
    // cursor moves down a line, and on the line below the window, the window
    // scrolls to keep it at the bottom — Neovim does not wrap, so its window
    // is `neovimRows` buffer lines tall.
    let topline = 1;
    for (let line = 2; line <= 8; line += 1) {
      await mounted.press(printable("j"));
      const from = editorTransport.viewports().length;
      const scrolled = line > topline + neovimRows - 1;
      if (scrolled) topline = line - neovimRows + 1;
      await act(async () => {
        editorTransport.emit({ type: "cursor", line, col: 1 });
        if (scrolled) {
          editorTransport.emit({ type: "viewport", topline, botline: topline + neovimRows });
        }
      });
      if (scrolled) {
        // The window moved, so the client follows it and tells Neovim.
        await waitForReal(
          () => editorTransport.viewports().length > from,
          2000,
          "a viewport request after the window scrolled",
        );
      }
      await nextFrames();
      for (const sent of editorTransport.viewports().slice(from)) {
        expect(
          sent.topline <= line && line <= sent.topline + sent.rows - 1,
          `after j to line ${line}, the client asked for topline ${sent.topline}, rows ${sent.rows}`,
        ).toBe(true);
      }
    }
    const shown = mounted.visibleRange();
    expect(
      shown !== null && shown.startLineNumber <= 8 && 8 <= shown.endLineNumber,
      `Monaco shows lines ${shown?.startLineNumber} to ${shown?.endLineNumber} with the caret on line 8`,
    ).toBe(true);
  });

  it("keeps the caret in view when a key lands on a later wrapped row of a long line", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    using _timers = fakeTimers();

    // Line 3 wraps to 20 rows at 180 columns. A key puts the caret on its 18th
    // row and Neovim makes line 3 its topline. Following that topline shows
    // the line's first 14 rows, so the caret's row is below the viewport even
    // though the line's own top is in it.
    const lines = ["# title", "", "y".repeat(3600), "", "tail"];
    const model = makeHarnessModel(
      lines,
      monacoFileModelKey(HARNESS_ENVIRONMENT_ID, CWD, HARNESS_RELATIVE_PATH),
    );
    editorTransport.setSnapshot({ lines, cursor: { line: 1, col: 1 }, topline: 1 });
    mounted = await mountNvimEditor({
      renderEditor: (editor) => <EditorUnderTest editor={editor} model={model} />,
      layout: { model, wrapColumn: 180, lineHeight: 20, height: 280 },
    });
    await waitForReal(
      () => editorTransport.viewports().length > 0,
      2000,
      "the client sends its first viewport",
    );

    await mounted.press(printable("j"));
    const caretColumn = 17 * 180 + 1;
    await act(async () => {
      editorTransport.emit({ type: "cursor", line: 3, col: caretColumn });
      editorTransport.emit({ type: "viewport", topline: 3, botline: 6 });
    });
    await nextFrames();
    await nextFrames();

    expect(mounted.showsPosition(3, caretColumn), "the caret's wrapped row is in view").toBe(true);
  });
});
