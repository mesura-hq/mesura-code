// @vitest-environment happy-dom
/**
 * Entry point: `MonacoFileSurface`, the file panel's editor, mounted whole —
 * its Neovim hook, its status strip, and the dismissal listeners it installs
 * on the document. Keys are dispatched on the focused element, so the
 * dismissal's capture listener sees each one before the editor's own
 * `onKeyDown` does, as in a browser. The session's replies and events are the
 * test's to time. See `mountMonacoFileSurface` in `~/test/nvimEditorHarness`
 * for what is real and what is replaced; below, the surface's save
 * coordinator, comment zones, settings, worker setup and query cache are
 * stubbed, none of which decides where Escape goes.
 *
 * Phase 3 of the editor latency cycle, "Escape never strands Neovim in insert
 * mode":
 * - 1: Escape goes to Neovim, not to dismissal, while a key for the thread is
 *   pending or the client's mode is not confirmed by Neovim; the editor
 *   dismisses on Escape only when Neovim has confirmed plain normal mode and
 *   no key is pending.
 * - 2: the S4 race (A, x, Escape 100 ms apart at 60 ms one-way delay) leaves
 *   Neovim in insert mode with focus outside the editor in 0 of 8 tries, and
 *   no key typed in the editor reaches the chat composer. The 0 of 8 number is
 *   the bench's S4 measurement, run by the coordinator and the verifier
 *   (`bench/bench.sh`, METHOD.md S4); the spec here replays the recorded order
 *   of one try on the client.
 * - 3: guards. Escape in confirmed normal mode with nothing pending still
 *   releases the editor, and flash's `jumping` state still keeps Escape.
 */
import type { EditorSessionEvent } from "@t3tools/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => () => import("~/test/nvimEditorHarness"));
vi.mock("~/connection/runtime", async () => (await harness()).mockConnectionRuntime());
vi.mock("~/state/server", async () => (await harness()).mockServerState());
vi.mock("monaco-editor", async () => (await harness()).mockMonacoEditor());
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(select: (settings: Record<string, unknown>) => T) =>
    select({ fontFamilyCode: "", fontSizeCode: 13 }),
}));
vi.mock("~/components/files/useFileSaveCoordinator", () => ({
  useFileSaveCoordinator: () => ({ change: () => {}, flush: async () => {} }),
}));
vi.mock("~/components/files/monaco/monacoFileComments", () => ({
  useMonacoFileComments: () => ({ zones: null, hasOpenDraft: false }),
}));
vi.mock("~/components/files/monaco/monacoEnvironment", () => ({
  ensureMonacoEnvironment: () => {},
}));
vi.mock("~/components/files/projectFilesQueryState", () => ({
  setProjectFileQueryData: () => {},
}));

import {
  ESCAPE,
  HARNESS_ENVIRONMENT_ID,
  HARNESS_RELATIVE_PATH,
  editorTransport,
  flushHarness,
  harnessThreadRef,
  makeHarnessModel,
  mountMonacoFileSurface,
  printable,
  settleUntil,
} from "~/test/nvimEditorHarness";
import { FileEditorRetention } from "../fileEditorRetention";
import { MonacoFileSurface } from "./MonacoFileSurface";
import { monacoFileModelKey, type MonacoFileModels } from "./monacoFileModels";

const CWD = "/harness/project";
const LINES = ["const answer = 42;", "", "export default answer;"];

let mounted: Awaited<ReturnType<typeof mountMonacoFileSurface>> | undefined;

/**
 * Opens the harness file in the surface with modal editing on and puts the
 * caret in it. Neovim's snapshot says plain normal mode, unless `snapshotHeld`
 * keeps it back: then Neovim has not reported any mode yet.
 */
async function openEditor(
  options: { readonly snapshotHeld?: boolean; readonly openHeld?: boolean } = {},
) {
  const model = makeHarnessModel(
    LINES,
    monacoFileModelKey(HARNESS_ENVIRONMENT_ID, CWD, HARNESS_RELATIVE_PATH),
  );
  editorTransport.setSnapshot({ lines: LINES, cursor: { line: 1, col: 1 }, mode: "n" });
  if (options.snapshotHeld === true) editorTransport.holdSnapshot();
  if (options.openHeld === true) editorTransport.holdOpens();
  const surface = await mountMonacoFileSurface({
    layout: { model, wrapColumn: 120, lineHeight: 18, height: 360 },
    renderSurface: (models) => (
      <MonacoFileSurface
        environmentId={HARNESS_ENVIRONMENT_ID}
        cwd={CWD}
        relativePath={HARNESS_RELATIVE_PATH}
        contents={LINES.join("\n")}
        resolvedTheme="dark"
        wordWrap
        revealLine={null}
        revealRequestId={0}
        retention={new FileEditorRetention()}
        models={models as MonacoFileModels}
        composerDraftTarget={harnessThreadRef}
        threadRef={harnessThreadRef}
        modalEditing
        onPendingChange={() => {}}
      />
    ),
  });
  mounted = surface;
  await settleUntil(
    () => editorTransport.requests.some((request) => request.method === "open"),
    "the surface opened the file in Neovim",
  );
  await surface.focusEditor();
  expect(surface.editorHasFocus(), "precondition: the caret is in the editor").toBe(true);
  return surface;
}

/** What the status strip names as the mode: NORMAL, INSERT, FLASH. */
const stripMode = (container: HTMLElement) =>
  container.querySelector("[data-nvim-status-strip] span")?.textContent ?? null;

/**
 * Neovim reports its mode, as the host plugin's `ModeChanged` push does, and
 * every key batch answered from here on answers it too.
 *
 * Confirmation is the batch's answer (`EditorSessionInputResult`); the stream
 * event is what the strip shows. Where Neovim will be once it consumes keys the
 * test has not answered yet, `editorTransport.setNeovimMode` says alone.
 */
async function neovimReports(mode: string, extra: { readonly jumping?: boolean } = {}) {
  editorTransport.setNeovimMode({ mode, jumping: extra.jumping ?? false });
  await act(async () => {
    editorTransport.emit({
      type: "mode",
      mode,
      blocking: false,
      ...(extra.jumping === undefined ? {} : { jumping: extra.jumping }),
    });
  });
  await flushHarness();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  editorTransport.reset();
});

afterEach(async () => {
  editorTransport.autoReplyAll();
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

describe("Escape in the file editor before Neovim has caught up with the keys", () => {
  it("sends Escape to Neovim instead of releasing the editor while a typed key is in flight", async () => {
    const surface = await openEditor();
    editorTransport.holdReplies();

    await surface.type(printable("A"));
    await settleUntil(() => editorTransport.inputs().length === 1, "A was sent");
    await surface.type(ESCAPE);

    expect(
      surface.editorHasFocus(),
      "Escape typed while A is unanswered released the editor; Neovim is left in insert mode",
    ).toBe(true);
    editorTransport.autoReplyAll();
    await settleUntil(() => editorTransport.appliedKeys().length >= 6, "Neovim was given A<Esc>");
    expect(editorTransport.appliedKeys(), "Escape reached Neovim, after A").toBe("A<Esc>");
  });

  it("sends Escape to Neovim when the key it acknowledged has not had its mode reported yet", async () => {
    const surface = await openEditor();
    // Neovim answers A from insert mode.
    editorTransport.setNeovimMode({ mode: "i" });

    await surface.type(printable("A"));
    await settleUntil(() => editorTransport.appliedKeys() === "A", "Neovim acknowledged A");
    // No mode event: Neovim took A, and the stream has not said it is in
    // insert mode. The strip's NORMAL predates the key.
    expect(stripMode(surface.container), "precondition: the client still says NORMAL").toBe(
      "NORMAL",
    );
    await surface.type(ESCAPE);

    expect(
      surface.editorHasFocus(),
      "Escape released the editor on a NORMAL that Neovim never confirmed after A",
    ).toBe(true);
    await settleUntil(
      () => editorTransport.appliedKeys().length >= 6,
      "Neovim was given the Escape",
    );
    expect(editorTransport.appliedKeys()).toBe("A<Esc>");
  });

  it("sends Escape to Neovim before the session has reported any mode", async () => {
    // Neither the attachment's snapshot nor the open's answer has arrived.
    const surface = await openEditor({ snapshotHeld: true, openHeld: true });

    // The strip's NORMAL is the client's default, not anything Neovim said.
    await surface.type(ESCAPE);

    expect(
      surface.editorHasFocus(),
      "Escape released the editor on a mode no Neovim has reported",
    ).toBe(true);
    await settleUntil(
      () => editorTransport.appliedKeys() === "<Esc>",
      "Neovim was given the Escape",
    );
  });
});

describe("the S4 Escape race, replayed on the client in its recorded order", () => {
  // The order of one try of `escape-race-d60-gap100` (60 ms one-way, keys
  // 100 ms apart): A goes out; x is typed while A is unanswered; A's reply
  // arrives and x goes out; Escape is typed while x is unanswered, with the
  // client still showing NORMAL; then x's reply, then Neovim's INSERT.
  it("keeps A, x, Escape and the keys after them in the editor when the replies trail the typing", async () => {
    const surface = await openEditor();
    editorTransport.holdReplies();
    // A and x are answered from insert mode.
    editorTransport.setNeovimMode({ mode: "i" });

    await surface.type(printable("A"));
    await settleUntil(() => editorTransport.inputs().length === 1, "A was sent");
    await surface.type(printable("x"));
    editorTransport.replyNext({ kind: "ok" });
    await settleUntil(() => editorTransport.inputs().length === 2, "x was sent after A's reply");
    await surface.type(ESCAPE);

    expect(
      surface.editorHasFocus(),
      "Escape typed while x is unanswered released the editor, as in 8 of 8 baseline tries",
    ).toBe(true);

    editorTransport.replyNext({ kind: "ok" });
    await neovimReports("i");
    // The Escape is answered from normal mode.
    editorTransport.setNeovimMode({ mode: "n" });
    editorTransport.autoReplyAll();
    await settleUntil(
      () => editorTransport.appliedKeys().startsWith("Ax<Esc>"),
      "Neovim was given A, x and the Escape, in order",
    );
    await neovimReports("n");

    // The bench's probe keys. Each one either reaches Neovim or lands outside
    // the editor, where the composer's type-to-focus would take it.
    for (const key of ["h", "l", "h"]) await surface.type(printable(key));
    await settleUntil(
      () => editorTransport.appliedKeys().length >= "Ax<Esc>hlh".length,
      "the probe keys reached Neovim",
    );

    expect(editorTransport.appliedKeys()).toBe("Ax<Esc>hlh");
    expect(surface.keysOutsideEditor, "keys typed in the editor that landed outside it").toEqual(
      [],
    );
  });
});

describe("Escape that still belongs to the panel, and to flash", () => {
  it("releases the editor on the first Escape after a fresh open", async () => {
    const surface = await openEditor();
    await settleUntil(() => stripMode(surface.container) === "NORMAL", "the strip says NORMAL");

    // The open's answer said plain normal mode, and nothing was typed since.
    await surface.type(ESCAPE);

    expect(surface.editorHasFocus(), "Escape right after opening releases the editor").toBe(false);
    await flushHarness();
    expect(editorTransport.appliedKeys(), "a releasing Escape is not sent to Neovim").toBe("");
  });

  it("ignores an open's answer when a key was typed while the open was in flight", async () => {
    const surface = await openEditor({ openHeld: true });
    // A is answered from insert mode before the open's answer arrives.
    editorTransport.setNeovimMode({ mode: "i" });
    await surface.type(printable("A"));
    await settleUntil(() => editorTransport.appliedKeys() === "A", "Neovim answered A");
    // The open's answer, read before A ran, says plain normal mode.
    editorTransport.setNeovimMode({ mode: "n" });
    await act(async () => editorTransport.replyNext({ kind: "ok" }, "open"));
    await flushHarness();
    await surface.type(ESCAPE);

    expect(surface.editorHasFocus(), "an open's answer overrode a later key's").toBe(true);
    await settleUntil(() => editorTransport.appliedKeys() === "A<Esc>", "Neovim was given Escape");
  });

  it("keeps Escape for Neovim after opening on an older host whose open answer says nothing", async () => {
    editorTransport.answerLikeAnOlderHost();
    const surface = await openEditor();

    await surface.type(ESCAPE);

    expect(surface.editorHasFocus(), "an open answer without escape state confirmed").toBe(true);
    await settleUntil(() => editorTransport.appliedKeys() === "<Esc>", "Neovim was given Escape");
  });

  it("releases the editor on Escape once typed keys are acknowledged and Neovim reports normal mode", async () => {
    const surface = await openEditor();

    await surface.type(printable("l"));
    await settleUntil(() => editorTransport.appliedKeys() === "l", "Neovim acknowledged l");
    await neovimReports("n");
    await surface.type(ESCAPE);

    expect(
      surface.editorHasFocus(),
      "Escape with nothing pending and normal mode confirmed after the last key releases the editor",
    ).toBe(false);
    await flushHarness();
    expect(editorTransport.appliedKeys()).toBe("l");
  });

  it("keeps Escape for Neovim while the last answer says a command waits, and releases on the next plain answer", async () => {
    const surface = await openEditor();
    // `d` is answered waiting for its motion, `f` waiting for its character.
    for (const [keys, waiting] of [
      ["d", { mode: "no" }],
      ["f", { mode: "n", blocking: true }],
    ] as const) {
      editorTransport.setNeovimMode(waiting);
      const before = editorTransport.appliedKeys();
      await surface.type(printable(keys));
      await settleUntil(
        () => editorTransport.appliedKeys() === before + keys,
        `Neovim answered ${keys}`,
      );
      // Neovim answers the Escape at rest in normal mode.
      editorTransport.setNeovimMode({ mode: "n" });
      await surface.type(ESCAPE);
      expect(surface.editorHasFocus(), `Escape after ${keys} released the editor`).toBe(true);
      await settleUntil(
        () => editorTransport.appliedKeys() === `${before}${keys}<Esc>`,
        `Neovim was given the Escape after ${keys}`,
      );
    }

    await surface.type(ESCAPE);
    expect(surface.editorHasFocus(), "an answer of plain normal mode did not release").toBe(false);
    expect(editorTransport.appliedKeys()).toBe("d<Esc>f<Esc>");
  });

  it("keeps Escape for Neovim while flash labels jump targets in normal mode", async () => {
    const surface = await openEditor();
    await neovimReports("n", { jumping: true });
    await settleUntil(
      () => surface.container.querySelector("[data-nvim-jumping]") !== null,
      "the strip says FLASH",
    );

    await surface.type(ESCAPE);

    expect(surface.editorHasFocus(), "Escape abandons the jump, not the editor").toBe(true);
    await settleUntil(
      () => editorTransport.appliedKeys() === "<Esc>",
      "Neovim was given the Escape",
    );
  });

  it("keeps Escape for Neovim once Neovim has confirmed insert mode", async () => {
    const surface = await openEditor();
    editorTransport.setNeovimMode({ mode: "i" });

    await surface.type(printable("A"));
    await settleUntil(() => editorTransport.appliedKeys() === "A", "Neovim acknowledged A");
    await neovimReports("i");
    await settleUntil(() => stripMode(surface.container) === "INSERT", "the strip says INSERT");
    await surface.type(ESCAPE);

    expect(surface.editorHasFocus(), "Escape leaves insert mode, not the editor").toBe(true);
    await settleUntil(
      () => editorTransport.appliedKeys() === "A<Esc>",
      "Neovim was given the Escape",
    );
  });
});

describe("Escape when a snapshot or the host cannot vouch for Neovim's mode", () => {
  /** Sends a fresh snapshot down the live attachment, as a reattach or a restart does. */
  const deliverSnapshot = async (...after: ReadonlyArray<EditorSessionEvent>) => {
    await act(async () => {
      editorTransport.emit(
        {
          type: "snapshot",
          snapshot: {
            relativePath: HARNESS_RELATIVE_PATH,
            lines: LINES,
            cursor: { line: 1, col: 1 },
            mode: "n",
            jumping: false,
            topline: 1,
            hlDefs: {},
          },
        },
        ...after,
      );
    });
    await flushHarness();
  };

  it("keeps Escape for Neovim when a normal-mode snapshot lands after a reply that confirmed insert mode", async () => {
    const surface = await openEditor();
    editorTransport.setNeovimMode({ mode: "i" });
    await surface.type(printable("A"));
    await settleUntil(() => editorTransport.appliedKeys() === "A", "Neovim answered A from insert");

    // A delayed snapshot, taken before A, says NORMAL; the strip follows it.
    await deliverSnapshot();
    expect(stripMode(surface.container), "precondition: the strip says NORMAL").toBe("NORMAL");
    await surface.type(ESCAPE);

    expect(surface.editorHasFocus(), "an older snapshot overrode the reply that said INSERT").toBe(
      true,
    );
    await settleUntil(() => editorTransport.appliedKeys() === "A<Esc>", "Neovim was given Escape");
  });

  it("keeps Escape for Neovim when an older host answers a key batch with nothing", async () => {
    const surface = await openEditor();
    editorTransport.answerLikeAnOlderHost();
    await surface.type(printable("A"));
    await settleUntil(() => editorTransport.appliedKeys() === "A", "the older host took A");

    // The stream has not said INSERT yet, and the answer says nothing at all.
    await surface.type(ESCAPE);

    expect(
      surface.editorHasFocus(),
      "an empty answer was taken as normal mode and released the editor",
    ).toBe(true);
    await settleUntil(() => editorTransport.appliedKeys() === "A<Esc>", "Neovim was given Escape");
  });

  it("keeps Escape for Neovim after a reattach snapshot says plain normal while f still waits", async () => {
    const surface = await openEditor();
    // Neovim answers `f` waiting for its character, as a native `f` does.
    editorTransport.setNeovimMode({ mode: "n", blocking: true });
    await surface.type(printable("f"));
    await settleUntil(() => editorTransport.appliedKeys() === "f", "Neovim answered f");

    // The session reattaches: the snapshot says plain `n`, and carries no
    // `blocking`, so it cannot say `f` is still waiting.
    await deliverSnapshot();
    await surface.type(ESCAPE);

    expect(surface.editorHasFocus(), "a snapshot cleared the wait the reply reported").toBe(true);
    await settleUntil(() => editorTransport.appliedKeys() === "f<Esc>", "Neovim was given Escape");
  });

  it("releases the editor on Escape after a snapshot and a message arrive together", async () => {
    // The restart path: a snapshot followed at once by a message, folded into
    // one render. The open's answer confirmed; the snapshot changes nothing.
    const surface = await openEditor();
    await deliverSnapshot({ type: "message", kind: "emsg", text: "Neovim restarted" });

    await surface.type(ESCAPE);

    expect(
      surface.editorHasFocus(),
      "the editor stayed captured after Neovim confirmed normal",
    ).toBe(false);
  });
});
