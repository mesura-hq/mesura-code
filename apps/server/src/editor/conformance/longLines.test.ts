import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EditorSessionEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import {
  benchMarkdownLines,
  benchTypeScriptLines,
  RECORDED_J_RUNS,
  type RecordedRun,
} from "./longLineFixtures.ts";
import { makeScratchManager, realConfigDirectory, recordChunks } from "./managerHarness.ts";
import { connectSideChannel, listeningAdapterLayer } from "./nvimSideChannel.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * Entry point: `EditorSessionManager.makeWithOptions`, driven through the calls
 * the websocket layer makes for `editorSession.open`, `.viewport` and `.input`
 * (`wsMesura.ts`), and read through `EditorSessionManager.attachEventStream`,
 * the stream it serves for `editorSession.attach`. Neovim is real, spawned by
 * `NodeNvimAdapter` with `--listen` added, so `nvimSideChannel.ts` can ask it
 * what the wire never says: how far the window is scrolled sideways
 * (`leftcol`) and where the cursor really is.
 *
 * Phase 2 of the editor latency cycle, "Long lines never scroll Neovim
 * sideways". Neovim draws nothing past its grid's last column, and with
 * 'nowrap' a cursor that reaches that column scrolls the window sideways. The
 * classification in `GridModel.ts` reads grid column N against buffer column
 * N, so after that scroll every visible character differs from the one it is
 * compared against and becomes a phantom overlay.
 *
 * The viewport each test sends is the one the web client sends today
 * (`nvimViewport.ts`): `cols` is the widest visible line, floor 200. Under
 * `MESURA_NVIM_CONFIG_DIR` the developer's own configuration is loaded, as
 * `realConfig.test.ts` loads it; without it, an empty one.
 *
 * - Criteria 1 and 2: `A` on the widest visible line, then 40 typed
 *   characters, leave `leftcol` at 0.
 * - Criterion 3: a window scrolled sideways anyway is classified against the
 *   buffer shifted by `leftcol`, so the shift alone is no overlay.
 * - Criterion 4: on the Markdown fixture, `A` plus 40 characters emit no
 *   overlay and at most 2 KB of events per key.
 * - Criterion 5: a visible line longer than the widest request the contract
 *   accepts (`cols` 1000) types and moves like any other line.
 * - Criterion 6: the real client's viewport requests, recorded during the
 *   bench's "50 j from the top", do not move the cursor the keys put: the
 *   cursor ends on line 51.
 * - Criterion 7: `A` plus 40 characters on the TypeScript fixture's longest
 *   line hold no overlay.
 *
 * Every wait is on an attach-stream event or an RPC answer, never a clock.
 */

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

const MARKDOWN = "long-lines.md";
const TYPESCRIPT = "sample.ts";

/** The 40 characters every typing test adds, as the bench's S5 types them. */
const FORTY_TYPED = Array.from({ length: 40 }, (_, index) => "word "[index % 5] ?? " ");

/** A manager with one file open on a real Neovim, its attach stream, and a side channel into it. */
const openFixture = (
  relativePath: string,
  lines: ReadonlyArray<string>,
  onRequest?: (method: string) => void,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "editor-long-lines-" });
    const socketPath = `${root}/nvim.sock`;
    const manager = yield* makeScratchManager(root).pipe(
      Effect.provide(listeningAdapterLayer(socketPath, onRequest)),
    );
    const threadId = `long-lines-${relativePath}`;
    yield* manager.open({ threadId, cwd: root, relativePath, lines: [...lines] });
    const { chunks, waitFor } = yield* recordChunks(manager, threadId);
    const side = yield* connectSideChannel(socketPath);

    const viewport = (topline: number, rows: number, cols: number) =>
      manager.viewport({ threadId, topline, rows, cols });

    /** Sends keys and waits for the cursor event that puts the caret at `line`, `col`. */
    const press = (keys: string, line: number, col?: number) =>
      Effect.gen(function* () {
        const from = chunks.length;
        yield* manager.input({ threadId, keys });
        yield* waitFor(
          (event) =>
            event.type === "cursor" &&
            event.line === line &&
            (col === undefined || event.col === col),
          from,
        );
      });

    /** Neovim's own view of the file's window. */
    const view = side.viewOf(relativePath);

    /** The text of one buffer line, from Neovim itself. */
    const bufferLine = (line: number) =>
      side
        .inFileWindow(
          relativePath,
          `return vim.api.nvim_buf_get_lines(0, ${line - 1}, ${line}, false)[1]`,
        )
        .pipe(Effect.map((text) => String(text)));

    return { manager, threadId, chunks, waitFor, viewport, press, view, bufferLine, side };
  });

type HeldOverlay = Extract<EditorSessionEvent, { type: "decorations" }>["overlays"][number];

/** The overlays a client holds once it has folded every chunk, as `editorSessionFold.ts` does. */
const heldOverlayList = (chunks: ReadonlyArray<ReadonlyArray<EditorSessionEvent>>) => {
  const held = new Map<number, HeldOverlay[]>();
  for (const chunk of chunks) {
    for (const event of chunk) {
      if (event.type !== "decorations") continue;
      for (const row of event.rows) held.delete(row);
      for (const overlay of event.overlays) {
        held.set(overlay.line, [...(held.get(overlay.line) ?? []), overlay]);
      }
    }
  }
  return [...held.values()].flat();
};

const heldOverlays = (chunks: ReadonlyArray<ReadonlyArray<EditorSessionEvent>>) =>
  heldOverlayList(chunks).length;

/** What the chunks from `from` on cost: overlays sent and JSON bytes, the wire's own encoding. */
const wireCost = (chunks: ReadonlyArray<ReadonlyArray<EditorSessionEvent>>, from: number) => {
  let overlays = 0;
  let bytes = 0;
  for (const chunk of chunks.slice(from)) {
    for (const event of chunk) {
      bytes += JSON.stringify(event).length;
      if (event.type === "decorations") overlays += event.overlays.length;
    }
  }
  return { overlays, bytes };
};

/**
 * `A` on `line`, then the 40 characters, each waited out to its cursor event.
 * Returns `leftcol` after `A` and after every typed character.
 */
const appendForty = (
  fixture: Effect.Success<ReturnType<typeof openFixture>>,
  line: number,
  length: number,
) =>
  Effect.gen(function* () {
    const leftcols: number[] = [];
    yield* fixture.press("A", line, length + 1);
    leftcols.push((yield* fixture.view).leftcol);
    for (const [index, key] of FORTY_TYPED.entries()) {
      yield* fixture.press(key, line, length + index + 2);
      leftcols.push((yield* fixture.view).leftcol);
    }
    return leftcols;
  });

/** Replays a recorded run: every key waited out to its cursor, every viewport answered. */
const replay = (fixture: Effect.Success<ReturnType<typeof openFixture>>, run: RecordedRun) =>
  Effect.gen(function* () {
    yield* fixture.viewport(...run.before);
    // `gg` on the first character of line 1 moves nothing, so no cursor event
    // would come to wait for.
    const start = yield* fixture.view;
    if (start.lnum !== 1 || start.col !== 0) yield* fixture.press("gg", 1, 1);
    for (const step of run.steps) {
      if (typeof step === "string") {
        const from = (yield* fixture.view).lnum;
        yield* fixture.press(step, from + step.length);
      } else {
        yield* fixture.viewport(...step);
      }
    }
    return (yield* fixture.view).lnum;
  });

if (!nvimAvailable) reportMissingNvim("long-lines harness");

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })(
    `long lines never scroll Neovim sideways (${realConfigDirectory === null ? "empty configuration" : "the developer's configuration"})`,
    (it) => {
      const markdown = benchMarkdownLines();
      const typescript = benchTypeScriptLines();
      /** S5's line: 940 characters, the widest of lines 98 to 104. */
      const MARKDOWN_LINE = 101;
      const MARKDOWN_LENGTH = markdown[MARKDOWN_LINE - 1]?.length ?? 0;
      /** The fixture's longest line, 1,087 characters, past the contract's `cols` bound. */
      const OVER_CAP_LINE = 231;
      const OVER_CAP_LENGTH = markdown[OVER_CAP_LINE - 1]?.length ?? 0;
      /** The TypeScript fixture's longest line, 225 characters. */
      const TYPESCRIPT_LINE = 467;
      const TYPESCRIPT_LENGTH = typescript[TYPESCRIPT_LINE - 1]?.length ?? 0;

      it.effect(
        "keeps leftcol at 0 after A on the widest visible line of a viewport sized to that line",
        () =>
          Effect.gen(function* () {
            const fixture = yield* openFixture(MARKDOWN, markdown);
            // What the client sends for lines 98 to 104: `cols` is the widest of
            // them, line 101, and `A` puts the caret one column past it.
            yield* fixture.viewport(98, 7, MARKDOWN_LENGTH);
            yield* fixture.press(`${MARKDOWN_LINE}G`, MARKDOWN_LINE);
            yield* fixture.press("A", MARKDOWN_LINE, MARKDOWN_LENGTH + 1);

            const { leftcol } = yield* fixture.view;
            assert.strictEqual(leftcol, 0, "the window scrolled sideways for A");
          }).pipe(Effect.scoped),
        60_000,
      );

      it.effect(
        "keeps leftcol at 0 while 40 typed characters run past the grid's last column",
        () =>
          Effect.gen(function* () {
            const fixture = yield* openFixture(MARKDOWN, markdown);
            yield* fixture.viewport(98, 7, MARKDOWN_LENGTH);
            yield* fixture.press(`${MARKDOWN_LINE}G`, MARKDOWN_LINE);

            const leftcols = yield* appendForty(fixture, MARKDOWN_LINE, MARKDOWN_LENGTH);
            const scrolled = leftcols.filter((leftcol) => leftcol !== 0).length;
            assert.strictEqual(
              scrolled,
              0,
              `leftcol after A and each typed key: ${leftcols.join(",")}`,
            );
          }).pipe(Effect.scoped),
        60_000,
      );

      /**
       * The fixture with line 101 three times as long, 2,822 characters: past
       * `MAX_GRID_COLUMNS`, so the host keeps the window scrolled sideways on
       * purpose and the classification has to read the shift. On a line that
       * fits, the host scrolls the window back before the next key.
       */
      const PAST_BOUND_LINE = Array.from({ length: 3 }, () => markdown[MARKDOWN_LINE - 1]).join(
        " ",
      );
      const pastBound = markdown.map((text, index) =>
        index === MARKDOWN_LINE - 1 ? PAST_BOUND_LINE : text,
      );

      /** Line 101 past the bound, the caret at its end, the window scrolled to show it. */
      const scrolledPastBound = Effect.gen(function* () {
        const fixture = yield* openFixture(MARKDOWN, pastBound);
        yield* fixture.viewport(98, 7, 200);
        yield* fixture.press(`${MARKDOWN_LINE}G`, MARKDOWN_LINE);
        yield* fixture.press("$", MARKDOWN_LINE, PAST_BOUND_LINE.length);
        return fixture;
      });

      it.effect(
        "classifies a window scrolled sideways against the buffer shifted by leftcol",
        () =>
          Effect.gen(function* () {
            const fixture = yield* scrolledPastBound;
            // The caret's next event comes after the drawing of that scroll.
            yield* fixture.press("h", MARKDOWN_LINE, PAST_BOUND_LINE.length - 1);

            const { leftcol } = yield* fixture.view;
            assert.isAbove(leftcol, 0, "precondition: the window is scrolled sideways");
            assert.strictEqual(
              heldOverlays(fixture.chunks),
              0,
              `overlays held with leftcol ${leftcol}`,
            );
          }).pipe(Effect.scoped),
        60_000,
      );

      it.effect(
        "places a label drawn over a window scrolled sideways at the buffer column it covers",
        () =>
          Effect.gen(function* () {
            // The other half of criterion 3: the shift alone is no overlay, and
            // real virtual text is still one, at the column it covers. A fix
            // that dropped every overlay while scrolled would pass the test
            // above and fail this one.
            const fixture = yield* scrolledPastBound;
            // 100 bytes before the end of an ASCII line is inside the window:
            // the caret is at the end and the grid is 2,048 columns wide.
            const labelByte = PAST_BOUND_LINE.length - 100;
            yield* fixture.side.inFileWindow(
              MARKDOWN,
              `local namespace = vim.api.nvim_create_namespace("long-lines-label")
               vim.api.nvim_buf_set_extmark(0, namespace, ${MARKDOWN_LINE - 1}, ${labelByte}, {
                 virt_text = { { "LABEL", "Search" } },
                 virt_text_pos = "overlay",
               })`,
            );
            yield* fixture.side.request("nvim_command", ["redraw"]);
            yield* fixture.press("h", MARKDOWN_LINE, PAST_BOUND_LINE.length - 1);

            const { leftcol } = yield* fixture.view;
            assert.isAbove(leftcol, 0, "precondition: the window is scrolled sideways");
            assert.deepStrictEqual(
              heldOverlayList(fixture.chunks).map(({ line, col, text }) => ({ line, col, text })),
              [{ line: MARKDOWN_LINE, col: labelByte + 1, text: "LABEL" }],
              `overlays held with leftcol ${leftcol}`,
            );
          }).pipe(Effect.scoped),
        60_000,
      );

      /**
       * What Neovim really draws at the left edge, past the bound so the shift
       * stays. A wide character the edge cuts in half is drawn as `<`, and an
       * unprintable one as the rest of its spelling: U+200B is `<200b>`, six
       * cells, and from `leftcol` 3 its last four, `00b>`. Both are the
       * buffer's own character. Counting U+200B as one cell put every
       * character after it in the wrong column.
       */
      const atLeftEdge = (text: string, leftcol: number, caretByte: number) =>
        Effect.gen(function* () {
          const fixture = yield* openFixture(MARKDOWN, ["", text, ""]);
          yield* fixture.viewport(1, 3, 200);
          yield* fixture.press("2G", 2);
          yield* fixture.side.inFileWindow(
            MARKDOWN,
            `vim.api.nvim_win_set_cursor(0, { 2, ${caretByte} })
             vim.fn.winrestview({ leftcol = ${leftcol} })`,
          );
          yield* fixture.side.request("nvim_command", ["redraw"]);
          // `l` moves the caret one character right inside the window, and its
          // cursor event follows the drawing of the scroll.
          const caretCol = (yield* fixture.view).col;
          yield* fixture.press("l", 2);
          const view = yield* fixture.view;
          assert.strictEqual(view.leftcol, leftcol, "precondition: Neovim kept the scroll");
          assert.isAbove(view.col, caretCol, "precondition: the caret moved");
          return heldOverlayList(fixture.chunks);
        });

      it.effect(
        "reads a wide character cut by the left edge, drawn as <, as the buffer's own",
        () =>
          Effect.gen(function* () {
            // a, <200b> (6 cells), 990 x, then 中 on screen columns 997 and 998.
            const text = `a\u200b${"x".repeat(990)}中${"y".repeat(2000)}`;
            const caretByte = 1 + 3 + 990 + 3 + 500;
            const held = yield* atLeftEdge(text, 998, caretByte);
            assert.deepStrictEqual(held, [], "overlays held with 中 cut at the left edge");
          }).pipe(Effect.scoped),
        60_000,
      );

      it.effect(
        "reads an unprintable character cut by the left edge as the rest of its spelling",
        () =>
          Effect.gen(function* () {
            const text = `a\u200b${"y".repeat(3000)}`;
            const held = yield* atLeftEdge(text, 3, 1 + 3 + 100);
            assert.deepStrictEqual(held, [], "overlays held with <200b> cut to 00b>");
          }).pipe(Effect.scoped),
        60_000,
      );

      it.effect(
        "puts a characterwise register at the end of a 300-character line without scrolling sideways",
        () =>
          Effect.gen(function* () {
            const line = "x".repeat(300);
            const fixture = yield* openFixture(MARKDOWN, [line, "short", "short"]);
            yield* fixture.viewport(1, 3, 300);
            yield* fixture.side.inFileWindow(
              MARKDOWN,
              `vim.fn.setreg("a", string.rep("y", 300), "c")`,
            );
            yield* fixture.press("$", 1, 300);
            yield* fixture.press('"ap', 1, 600);

            assert.strictEqual((yield* fixture.bufferLine(1)).length, 600, "the register was put");
            assert.strictEqual((yield* fixture.view).leftcol, 0, "leftcol after the put");
            assert.strictEqual(heldOverlays(fixture.chunks), 0, "overlays held after the put");
          }).pipe(Effect.scoped),
        60_000,
      );

      it.effect(
        "emits no overlay and at most 2 KB per key for A plus 40 characters on a long Markdown line",
        () =>
          Effect.gen(function* () {
            const fixture = yield* openFixture(MARKDOWN, markdown);
            yield* fixture.viewport(98, 7, MARKDOWN_LENGTH);
            yield* fixture.press(`${MARKDOWN_LINE}G`, MARKDOWN_LINE);

            const from = fixture.chunks.length;
            yield* appendForty(fixture, MARKDOWN_LINE, MARKDOWN_LENGTH);
            const { overlays, bytes } = wireCost(fixture.chunks, from);
            const perKey = Math.round(bytes / (FORTY_TYPED.length + 1));
            assert.strictEqual(overlays, 0, `overlays emitted (${perKey} bytes per key)`);
            assert.isAtMost(perKey, 2048, "bytes of events per key");
          }).pipe(Effect.scoped),
        60_000,
      );

      it.effect(
        "types and moves on a visible line longer than the contract's 1,000-column bound",
        () =>
          Effect.gen(function* () {
            const fixture = yield* openFixture(MARKDOWN, markdown);
            // The widest request the contract accepts today. A visible line can
            // always be longer than any bound — a minified file has megabyte
            // lines — so the host has to cope with a grid narrower than the text.
            yield* fixture.viewport(228, 7, 1000);
            yield* fixture.press(`${OVER_CAP_LINE}G`, OVER_CAP_LINE);
            yield* appendForty(fixture, OVER_CAP_LINE, OVER_CAP_LENGTH);

            assert.strictEqual(
              yield* fixture.bufferLine(OVER_CAP_LINE),
              `${markdown[OVER_CAP_LINE - 1]}${FORTY_TYPED.join("")}`,
              "Neovim holds the typed text",
            );
            assert.strictEqual(heldOverlays(fixture.chunks), 0, "overlays held after typing");

            const typedLength = OVER_CAP_LENGTH + FORTY_TYPED.length;
            yield* fixture.press("<Esc>0", OVER_CAP_LINE, 1);
            yield* fixture.press("$", OVER_CAP_LINE, typedLength);
            yield* fixture.press("j", OVER_CAP_LINE + 1);
            yield* fixture.press("k", OVER_CAP_LINE);
            assert.strictEqual(heldOverlays(fixture.chunks), 0, "overlays held after the motions");
          }).pipe(Effect.scoped),
        60_000,
      );

      it.effect(
        "holds no overlay after A plus 40 characters on the TypeScript fixture's longest line",
        () =>
          Effect.gen(function* () {
            const fixture = yield* openFixture(TYPESCRIPT, typescript);
            yield* fixture.viewport(457, 30, TYPESCRIPT_LENGTH);
            yield* fixture.press(`${TYPESCRIPT_LINE}G`, TYPESCRIPT_LINE);
            yield* appendForty(fixture, TYPESCRIPT_LINE, TYPESCRIPT_LENGTH);

            assert.strictEqual(heldOverlays(fixture.chunks), 0, "overlays held after typing");
          }).pipe(Effect.scoped),
        60_000,
      );

      // The TypeScript run at 0 ms already lands on line 51 at the base of
      // this phase, so it is a guard: the bench measured it correct there too.
      it.effect.each([
        { name: "the Markdown fixture at 0 ms", path: MARKDOWN, run: "markdownAtDelay0" },
        { name: "the Markdown fixture at 20 ms", path: MARKDOWN, run: "markdownAtDelay20" },
        { name: "the TypeScript fixture at 0 ms", path: TYPESCRIPT, run: "typescriptAtDelay0" },
        { name: "the TypeScript fixture at 20 ms", path: TYPESCRIPT, run: "typescriptAtDelay20" },
      ] as const)(
        "lands on line 51 after the client's recorded 50 j and viewport requests on $name",
        ({ path, run }) =>
          Effect.gen(function* () {
            const fixture = yield* openFixture(path, path === MARKDOWN ? markdown : typescript);
            const line = yield* replay(fixture, RECORDED_J_RUNS[run]);
            assert.strictEqual(line, 51, "the cursor's line after 50 j from the top");
          }).pipe(Effect.scoped),
        60_000,
      );

      /**
       * Guard: the `<C-d>` scroll path. A half page moves the window and the
       * cursor together, Neovim sends `grid_scroll` for the rows it kept, and
       * `GridModel` must move those rows rather than read them against the
       * lines now under them.
       */
      /**
       * What the reservation in `mayExpandUnpredictably` costs in ordinary
       * use. A count, a `.` or an Ex command reserves the grid's whole bound
       * before it is sent, because its width is Neovim's to know; on a file of
       * short lines that is one widening for the burst, never a resize per
       * key, and the keys cost what plain motions and edits cost.
       *
       * The client is played as it behaves: after a key scrolls Neovim's
       * window it sends the new window, `cols` 200, as `nvimViewport.ts`
       * computes it for short lines. A viewport that shrank the reserved grid
       * would make the next count widen it again, a resize per key pair.
       */
      const SHORT_LINES = Array.from(
        { length: 300 },
        (_, index) => `const value${index} = compute(${index}, "short line"); // ${index}`,
      );

      const burstCost = (bursts: ReadonlyArray<ReadonlyArray<string>>) =>
        Effect.gen(function* () {
          let resizes = 0;
          const fixture = yield* openFixture(TYPESCRIPT, SHORT_LINES, (method) => {
            if (method === "nvim_ui_try_resize_grid" || method === "nvim_ui_try_resize") {
              resizes += 1;
            }
          });
          yield* fixture.viewport(1, 30, 200);
          let topline = 1;
          const costs: Array<{ resizes: number; bytesPerKey: number }> = [];
          for (const keys of bursts) {
            const fromResizes = resizes;
            const from = fixture.chunks.length;
            for (const key of keys) {
              const before = fixture.chunks.length;
              yield* fixture.manager.input({ threadId: fixture.threadId, keys: key });
              yield* fixture.manager.settleForTest({ threadId: fixture.threadId });
              const view = yield* fixture.view;
              // Every key here moves the caret or changes its line, and the
              // event for it is the last one that key causes.
              yield* fixture.waitFor(
                (event) =>
                  (event.type === "cursor" &&
                    event.line === view.lnum &&
                    event.col === view.col + 1) ||
                  event.type === "lines",
                before,
              );
              if (view.topline !== topline) {
                topline = view.topline;
                yield* fixture.viewport(topline, 30, 200);
              }
            }
            const { bytes } = wireCost(fixture.chunks, from);
            costs.push({
              resizes: resizes - fromResizes,
              bytesPerKey: Math.round(bytes / keys.length),
            });
          }
          return costs;
        });

      it.effect(
        "widens the grid at most once for a burst of counts and repeats on short lines",
        () =>
          Effect.gen(function* () {
            const [plain, counted] = yield* burstCost([
              ["j", "j", "j", "w", "w", "b", "dw", "j", "dw", "k", "j", "j"],
              [
                "3j",
                "d2w",
                ".",
                "10j",
                "2w",
                ".",
                "5k",
                "3j",
                "d2w",
                "20j",
                ".",
                ":s/value/v/<CR>",
              ],
            ]);
            assert.isAtMost(
              counted!.resizes,
              1,
              `grid resizes for the counted burst (plain: ${plain!.resizes})`,
            );
            assert.isAtMost(
              counted!.bytesPerKey,
              Math.max(2 * plain!.bytesPerKey, plain!.bytesPerKey + 600),
              `bytes per key, counted ${counted!.bytesPerKey} against plain ${plain!.bytesPerKey}`,
            );
          }).pipe(Effect.scoped),
        60_000,
      );

      it.effect("scrolls half a window on <C-d> through the manager and holds no overlay", () =>
        Effect.gen(function* () {
          const fixture = yield* openFixture(TYPESCRIPT, typescript);
          yield* fixture.viewport(1, 30, 200);
          yield* fixture.press("<C-d>", 16);

          const { topline } = yield* fixture.view;
          assert.strictEqual(topline, 16, "the window moved half a page");
          assert.strictEqual(heldOverlays(fixture.chunks), 0, "overlays held after <C-d>");
        }).pipe(Effect.scoped),
      );
    },
  );
