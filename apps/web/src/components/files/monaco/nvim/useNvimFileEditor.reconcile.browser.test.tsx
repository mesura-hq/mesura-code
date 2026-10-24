import { act } from "../../../../../test/render";
/**
 * Entry point: `useNvimFileEditor`, the hook `MonacoFileSurface` mounts for
 * modal editing, rendered under React over a model that takes edits
 * (`makeEditableHarnessModel` in `~/test/nvimEditorHarness.tsx`). Neovim's
 * answers arrive on the real attach subscription, are folded by the real
 * `editorSessionFold`, and reach the model through the real `useNvimDriver`.
 *
 * Guards for phase 4 of the editor latency cycle ("One key costs one small
 * render"). That phase moves the cursor out of the passive effect and stops
 * reading the whole model for events that change no text, which is the code
 * every guarantee below runs through:
 *
 * - the model ends at the session's text whatever arrives in one render —
 *   one lines event, two of them, a snapshot, a delta for another file;
 * - text and caret from one chunk land together (phase 1, criterion 4);
 * - Neovim's own edits are never read back as composed input;
 * - a decoration's widget keeps its node while unrelated events arrive;
 * - a `:w` that shares a render with any other event still flushes the save.
 */
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
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
  makeEditableHarnessModel,
  mountNvimEditor,
  recordEditorCalls,
  waitForReal,
} from "~/test/nvimEditorHarness";
import { editorSessionAttach } from "~/state/editorSession";
import { monacoFileModelKey } from "../monacoFileModels";
import { useNvimFileEditor } from "./useNvimFileEditor";

const CWD = "/harness/project";
const EXTERNAL_EDITS = { isApplying: () => false, run: (body: () => void) => body() };
const LINES = ["alpha", "beta", "gamma"];

type EditableModel = ReturnType<typeof makeEditableHarnessModel>;

function EditorUnderTest(props: {
  readonly editor: unknown;
  readonly model: EditableModel;
  readonly flushSave: () => void;
}) {
  useNvimFileEditor({
    editor: props.editor as Parameters<typeof useNvimFileEditor>[0]["editor"],
    model: props.model as unknown as Parameters<typeof useNvimFileEditor>[0]["model"],
    environmentId: HARNESS_ENVIRONMENT_ID,
    threadRef: harnessThreadRef,
    cwd: CWD,
    relativePath: HARNESS_RELATIVE_PATH,
    enabled: true,
    externalEdits: EXTERNAL_EDITS,
    flushSave: props.flushSave,
  });
  return null;
}

let mounted: Awaited<ReturnType<typeof mountNvimEditor>> | undefined;

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

/** Mounts the hook over `LINES`, with the session agreeing, and waits for it to settle. */
async function mountReconciled(lines: ReadonlyArray<string> = LINES) {
  const model = makeEditableHarnessModel(
    lines,
    monacoFileModelKey(HARNESS_ENVIRONMENT_ID, CWD, HARNESS_RELATIVE_PATH),
  );
  editorTransport.setSnapshot({ lines, cursor: { line: 1, col: 1 }, topline: 1 });
  const flushSave = vi.fn();
  let recorder: ReturnType<typeof recordEditorCalls> | null = null;
  mounted = await mountNvimEditor({
    renderEditor: (editor) => {
      recorder ??= recordEditorCalls(editor);
      return <EditorUnderTest editor={recorder.editor} model={model} flushSave={flushSave} />;
    },
    layout: { model: model as never, wrapColumn: 180, lineHeight: 20, height: 300 },
  });
  if (recorder === null) throw new Error("the editor was never rendered");
  const { calls } = recorder as ReturnType<typeof recordEditorCalls>;
  await waitForReal(
    () => editorTransport.viewports().length > 0,
    2000,
    "the client sends its first viewport",
  );
  await flushHarness();
  return { model, flushSave, calls };
}

async function deliver(...events: ReadonlyArray<EditorSessionEvent>) {
  await act(async () => {
    editorTransport.emit(...events);
  });
  await flushHarness();
}

const lastPosition = (calls: ReadonlyArray<{ method: string; args: ReadonlyArray<unknown> }>) =>
  calls.findLast((call) => call.method === "setPosition")?.args[0];

describe("the model follows Neovim's text whatever one render carries", () => {
  it("applies one lines event and puts the caret where its cursor event says", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { model, calls } = await mountReconciled();

    await deliver(
      { type: "lines", relativePath: HARNESS_RELATIVE_PATH, first: 1, last: 2, lines: ["beta!"] },
      { type: "cursor", line: 2, col: 5 },
    );

    expect(model.getLinesContent()).toEqual(["alpha", "beta!", "gamma"]);
    expect(lastPosition(calls)).toEqual({ lineNumber: 2, column: 5 });
    expect(editorTransport.inputs(), "Neovim's own edit read back as typing").toEqual([]);
  });

  it("ends at the session's text when two lines events land between two renders", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { model } = await mountReconciled();

    await deliver(
      { type: "lines", relativePath: HARNESS_RELATIVE_PATH, first: 0, last: 1, lines: ["ALPHA"] },
      {
        type: "lines",
        relativePath: HARNESS_RELATIVE_PATH,
        first: 3,
        last: 3,
        lines: ["delta", "epsilon"],
      },
    );

    expect(model.getLinesContent()).toEqual(["ALPHA", "beta", "gamma", "delta", "epsilon"]);
    expect(editorTransport.inputs(), "Neovim's own edit read back as typing").toEqual([]);
  });

  it("follows a run of single-line events typed one render apart, then a line deleted", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { model } = await mountReconciled();

    for (const text of ["gamma!", "gamma!!", "gamma!!!"]) {
      await deliver(
        { type: "lines", relativePath: HARNESS_RELATIVE_PATH, first: 2, last: 3, lines: [text] },
        { type: "cursor", line: 3, col: text.length },
      );
    }
    await deliver(
      { type: "lines", relativePath: HARNESS_RELATIVE_PATH, first: 1, last: 2, lines: [] },
      { type: "cursor", line: 2, col: 1 },
    );

    expect(model.getLinesContent()).toEqual(["alpha", "gamma!!!"]);
  });

  it("reconciles to a new snapshot that differs from the model", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { model } = await mountReconciled();

    await deliver({
      type: "snapshot",
      snapshot: {
        relativePath: HARNESS_RELATIVE_PATH,
        lines: ["alpha", "BETA", "gamma", "omega"],
        cursor: { line: 4, col: 1 },
        mode: "n",
        jumping: false,
        topline: 1,
        hlDefs: {},
      },
    });

    expect(model.getLinesContent()).toEqual(["alpha", "BETA", "gamma", "omega"]);
  });

  it("leaves the model alone for a lines event that names another file", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { model } = await mountReconciled();

    await deliver(
      { type: "lines", relativePath: "other.txt", first: 0, last: 1, lines: ["not this file"] },
      { type: "cursor", line: 1, col: 1 },
    );

    expect(model.getLinesContent()).toEqual(LINES);
  });

  it("applies a lines event that arrives after text-free events in the same render", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { model, calls } = await mountReconciled();

    await deliver(
      { type: "mode", mode: "i", blocking: false },
      { type: "message", kind: "echo", text: "-- INSERT --" },
      { type: "lines", relativePath: HARNESS_RELATIVE_PATH, first: 0, last: 1, lines: ["xalpha"] },
      { type: "cursor", line: 1, col: 2 },
    );

    expect(model.getLinesContent()).toEqual(["xalpha", "beta", "gamma"]);
    expect(lastPosition(calls)).toEqual({ lineNumber: 1, column: 2 });
  });
});

describe("what is drawn and written around the text", () => {
  it("keeps a decoration's widget node while cursor and mode events arrive", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { calls } = await mountReconciled();
    await deliver({
      type: "decorations",
      overlays: [{ line: 2, col: 1, text: "s", hl: 7 }],
      highlightRuns: [],
      rows: [2],
    });
    const added = calls.filter((call) => call.method === "addContentWidget").length;
    expect(added, "precondition: the label is on screen").toBe(1);

    for (let line = 1; line <= 3; line += 1) {
      await deliver({ type: "cursor", line, col: 1 }, { type: "mode", mode: "n", blocking: false });
    }

    expect(calls.filter((call) => call.method === "addContentWidget").length).toBe(1);
    expect(calls.filter((call) => call.method === "removeContentWidget").length).toBe(0);
  });

  it("flushes the save for a write request that shares a render with a cursor event", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { flushSave } = await mountReconciled();

    await deliver(
      { type: "writeRequested", relativePath: HARNESS_RELATIVE_PATH },
      { type: "cursor", line: 1, col: 1 },
      { type: "message", kind: "echo", text: '"notes.txt" written' },
    );

    expect(flushSave).toHaveBeenCalledTimes(1);
  });
});

describe("opening a file whose session already holds older text", () => {
  // The model carries an edit the session has not seen — modal editing was
  // turned off and on, or the panel came back to a kept model — while the
  // session, and the attachment's cached state, still hold the text from
  // before it.
  const LOCAL = ["new local edit", "beta"];
  const CACHED = ["stale Neovim text", "beta"];

  function localModel() {
    return makeEditableHarnessModel(
      LOCAL,
      monacoFileModelKey(HARNESS_ENVIRONMENT_ID, CWD, HARNESS_RELATIVE_PATH),
    );
  }

  const cachedSnapshot = {
    relativePath: HARNESS_RELATIVE_PATH,
    lines: CACHED,
    cursor: { line: 1, col: 1 },
    mode: "n",
    jumping: false,
    topline: 1,
    hlDefs: {},
  };

  it("opens with the editor's own text when the attachment already cached the older snapshot", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const model = localModel();
    editorTransport.setSnapshot({ lines: CACHED, cursor: { line: 1, col: 1 }, topline: 1 });
    const showEditor = { current: (_show: boolean) => {} };
    function EditorAfterCachedAttach(props: { readonly editor: unknown }) {
      // Another view of the thread keeps the attachment, and its snapshot, alive.
      useAtomValue(
        editorSessionAttach({
          environmentId: HARNESS_ENVIRONMENT_ID,
          input: { threadId: harnessThreadRef.threadId },
        }),
      );
      const [show, setShow] = useState(false);
      useEffect(() => {
        showEditor.current = setShow;
      }, []);
      return show ? (
        <EditorUnderTest editor={props.editor} model={model} flushSave={() => {}} />
      ) : null;
    }
    mounted = await mountNvimEditor({
      renderEditor: (editor) => <EditorAfterCachedAttach editor={editor} />,
      layout: { model: model as never, wrapColumn: 180, lineHeight: 20, height: 300 },
    });
    await flushHarness();

    await act(async () => showEditor.current(true));
    await waitForReal(
      () => editorTransport.openedLines().length > 0,
      2000,
      "the driver opens the file in the session",
    );
    await flushHarness();

    expect(editorTransport.openedLines()[0], "the text the open handed Neovim").toEqual(LOCAL);
    expect(model.getLinesContent(), "the text on screen").toEqual(LOCAL);
  });

  it("keeps the editor's text while an older snapshot arrives during the open", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const model = localModel();
    editorTransport.setSnapshot({ lines: CACHED, cursor: { line: 1, col: 1 }, topline: 1 });
    editorTransport.holdOpens();
    mounted = await mountNvimEditor({
      renderEditor: (editor) => (
        <EditorUnderTest editor={editor} model={model} flushSave={() => {}} />
      ),
      layout: { model: model as never, wrapColumn: 180, lineHeight: 20, height: 300 },
    });
    await waitForReal(
      () => editorTransport.openedLines().length > 0,
      2000,
      "the driver opens the file in the session",
    );
    // An attachment made before the open answers with the session as it was.
    await act(async () => {
      editorTransport.emit({ type: "snapshot", snapshot: cachedSnapshot });
    });
    await flushHarness();
    expect(model.getLinesContent(), "the text on screen before the open answers").toEqual(LOCAL);

    await act(async () => editorTransport.replyNext({ kind: "ok" }, "open"));
    await flushHarness();

    expect(editorTransport.openedLines()[0], "the text the open handed Neovim").toEqual(LOCAL);
    expect(model.getLinesContent(), "the text on screen after the open").toEqual(LOCAL);
  });
});
