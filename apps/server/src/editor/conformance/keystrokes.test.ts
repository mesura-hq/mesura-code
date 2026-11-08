import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { NvimAdapter } from "../NvimAdapter.ts";
import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { APPLY_EDITS_LUA, SET_VIEWPORT_LUA } from "../hostPlugin.ts";
import { NvimBridge, type NvimBridgeError, type NvimBridgeEvent } from "../NvimBridge.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * Drives a real `nvim --embed --clean` and asserts the bridge's mirror equals what Neovim reports
 * after each key sequence: a drifted mirror looks correct until the next save. Every wait is on a
 * `flush`, a buffer-lines event or an RPC response, never a clock.
 */

// `provideMerge` rather than `mergeAll`: the adapter needs the spawner that
// NodeServices carries, and `mergeAll` builds in parallel so the dependency
// would not be satisfied.
const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** Opens a bridge over a real Neovim, seeded with `lines`. */
const withNvim = <A>(
  lines: ReadonlyArray<string>,
  body: (bridge: NvimBridge.Session) => Effect.Effect<A, NvimBridgeError, never>,
) =>
  Effect.gen(function* () {
    const bridge = yield* NvimBridge.spawn({ cols: 80, rows: 24 });
    yield* bridge.setLines(lines);
    return yield* body(bridge);
  }).pipe(Effect.scoped);

/**
 * Types keys and returns once Neovim has executed them. `type`, not `input`: nothing reports when
 * `nvim_input` is consumed. `awaitFlush` is not enough either: it assumes the key is the only thing
 * drawing, which holds only under `--clean`.
 */
const send = (bridge: NvimBridge.Session, keys: string) =>
  Effect.gen(function* () {
    yield* bridge.type(keys);
    yield* bridge.settle;
  });

/** What Neovim itself says, to compare the mirror against. */
const truth = (bridge: NvimBridge.Session) =>
  Effect.gen(function* () {
    const lines = (yield* bridge.request("nvim_buf_get_lines", [0, 0, -1, false])) as string[];
    const cursor = (yield* bridge.request("nvim_win_get_cursor", [0])) as [number, number];
    const mode = (yield* bridge.request("nvim_get_mode", [])) as { mode: string };
    // The wire counts columns in UTF-16 units, as Monaco does; Neovim in bytes.
    const cursorLine = lines[cursor[0] - 1] ?? "";
    const col = Buffer.from(cursorLine).subarray(0, cursor[1]).toString().length + 1;
    return { lines, cursor: { line: cursor[0], col }, mode: mode.mode };
  });

/** One case of the keystroke table. */
interface KeystrokeCase {
  readonly name: string;
  readonly lines: ReadonlyArray<string>;
  readonly keys: ReadonlyArray<string>;
}

const KEYSTROKE_CASES: ReadonlyArray<KeystrokeCase> = [
  { name: "j moves down", lines: ["one", "two", "three"], keys: ["j"] },
  // Accents are two bytes and one UTF-16 unit, the emoji six bytes and two
  // units: the byte column put the caret past the end of these lines.
  { name: "$ lands on an accented line's last character", lines: ["café ñandú"], keys: ["$"] },
  { name: "w crosses an emoji", lines: ["⚠️ aviso — sí"], keys: ["w", "w"] },
  { name: "dd deletes a line", lines: ["one", "two", "three"], keys: ["dd"] },
  { name: "ciw changes a word", lines: ["alpha beta"], keys: ["ciw", "gamma", "<Esc>"] },
  {
    name: 'ci" changes inside quotes',
    lines: ['const a = "old";'],
    keys: ['f"', 'ci"', "new", "<Esc>"],
  },
  { name: "o opens a line below", lines: ["one"], keys: ["o", "two", "<Esc>"] },
  { name: "u undoes", lines: ["one", "two"], keys: ["dd", "u"] },
  { name: "Ctrl-R redoes", lines: ["one", "two"], keys: ["dd", "u", "<C-r>"] },
  { name: "visual delete", lines: ["abcdef"], keys: ["v", "ll", "d"] },
  { name: "substitute", lines: ["foo foo foo"], keys: [":s/foo/bar/g<CR>"] },
  { name: "dot repeats", lines: ["aa", "aa", "aa"], keys: ["x", "j", "."] },
  { name: "x on a multibyte line", lines: ["héllo wörld"], keys: ["x"] },
  { name: "insert into an empty file", lines: [""], keys: ["i", "first", "<Esc>"] },
  // A Neovim buffer can never hold zero lines. Deleting every one of them sends
  // an event whose replacement is empty and then silently reinstates a single
  // blank line, without telling attached clients — so a mirror that applies the
  // event faithfully ends up one line short of the truth.
  {
    name: "deleting every line leaves one empty line",
    lines: ["one", "two", "three"],
    keys: ["ggVGd"],
  },
  { name: "dG from the top empties the buffer the same way", lines: ["a", "b"], keys: ["dG"] },
  // A sequence that changes nothing. It belongs here precisely because it is
  // the case a flush-based settle could not express: no redraw follows, so
  // waiting for a frame waits forever, while draining the typeahead returns.
  { name: "gg at the top of the buffer is a no-op", lines: ["one", "two"], keys: ["gg"] },
];

if (!nvimAvailable) reportMissingNvim("keystroke conformance harness");

/** Everything a bridge tells its listeners, for the life of the body. */
const collecting = <A>(
  bridge: NvimBridge.Session,
  body: (events: ReadonlyArray<NvimBridgeEvent>) => Effect.Effect<A, NvimBridgeError, never>,
) =>
  Effect.gen(function* () {
    const events: NvimBridgeEvent[] = [];
    const unsubscribe = bridge.subscribe((event) => {
      events.push(event);
    });
    return yield* body(events).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
  });

it.layer(layer, { excludeTestServices: true })("conformance: a Neovim that is not there", (it) => {
  it.effect("says the binary is missing, rather than that something failed", () =>
    Effect.gen(function* () {
      // The real spawner, not a hand-written error: the classifier once matched `ENOENT` and
      // `not found` while Effect reports `NotFound`, so a missing Neovim read as a plain failure.
      const adapter = yield* NvimAdapter;
      const result = yield* adapter
        .spawn({
          executable: "mesura-nvim-that-does-not-exist",
          args: ["--embed"],
          env: {},
          cwd: undefined,
        })
        .pipe(Effect.scoped, Effect.result);

      assert.isTrue(Result.isFailure(result), "spawning something absent fails");
      const failure = Result.isFailure(result) ? result.failure : null;
      assert.strictEqual(
        failure?.reason,
        "binary-missing",
        `a missing binary is told apart from a real failure: ${failure?.message ?? ""}`,
      );
    }).pipe(Effect.scoped),
  );
});

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("conformance: the command line", (it) => {
    it.effect("reports what is being typed, and that it closed", () =>
      withNvim(["one", "two"], (bridge) =>
        collecting(bridge, (events) =>
          Effect.gen(function* () {
            yield* bridge.input(":");
            yield* bridge.input("noh");
            yield* bridge.awaitFlush;

            const shown = events.filter((event) => event.kind === "cmdline");
            const last = shown[shown.length - 1];
            assert.isDefined(last, "Neovim reported the command line");
            assert.strictEqual(last?.kind === "cmdline" ? last.cmdline?.firstc : null, ":");
            assert.strictEqual(last?.kind === "cmdline" ? last.cmdline?.content : null, "noh");

            yield* bridge.input("<Esc>");
            yield* bridge.awaitFlush;
            const closed = events.filter((event) => event.kind === "cmdline");
            const afterEscape = closed[closed.length - 1];
            assert.isNull(
              afterEscape?.kind === "cmdline" ? afterEscape.cmdline : undefined,
              "and that it closed again",
            );
          }),
        ),
      ),
    );

    it.effect("reports a search the same way", () =>
      withNvim(["alpha", "beta"], (bridge) =>
        collecting(bridge, (events) =>
          Effect.gen(function* () {
            yield* bridge.input("/bet");
            yield* bridge.awaitFlush;
            const shown = events.filter((event) => event.kind === "cmdline");
            const last = shown[shown.length - 1];
            assert.strictEqual(last?.kind === "cmdline" ? last.cmdline?.firstc : null, "/");
            assert.strictEqual(last?.kind === "cmdline" ? last.cmdline?.content : null, "bet");
          }),
        ),
      ),
    );

    it.effect("follows the caret when it moves without the text changing", () =>
      withNvim(["one"], (bridge) =>
        collecting(bridge, (events) =>
          Effect.gen(function* () {
            yield* bridge.input(":");
            yield* bridge.input("abcd");
            yield* bridge.awaitFlush;
            yield* bridge.input("<Left>");
            yield* bridge.input("<Left>");
            yield* bridge.awaitFlush;

            const shown = events.filter((event) => event.kind === "cmdline");
            const last = shown[shown.length - 1];
            const cmdline = last?.kind === "cmdline" ? last.cmdline : null;
            assert.strictEqual(cmdline?.content, "abcd", "the text did not change");
            // `cmdline_pos` is the only event Neovim sends for this, and it
            // carries nothing but the position. Ignoring it freezes the caret in
            // the strip wherever the last `cmdline_show` left it.
            assert.strictEqual(cmdline?.pos, 2, "and the caret went back two");
          }),
        ),
      ),
    );

    it.effect("counts the caret in characters, not in Vim's bytes", () =>
      withNvim(["one"], (bridge) =>
        collecting(bridge, (events) =>
          Effect.gen(function* () {
            // `café` is five bytes and four characters. A client slicing the
            // content at a byte offset puts the caret inside the `é`.
            yield* bridge.input("/");
            yield* bridge.input("café");
            yield* bridge.awaitFlush;
            const shown = events.filter((event) => event.kind === "cmdline");
            const last = shown[shown.length - 1];
            const cmdline = last?.kind === "cmdline" ? last.cmdline : null;
            assert.strictEqual(cmdline?.content, "café");
            assert.strictEqual(cmdline?.pos, 4, "four characters in, not five bytes");
          }),
        ),
      ),
    );

    it.effect("answers :messages, which arrives under its own name", () =>
      withNvim(["one"], (bridge) =>
        collecting(bridge, (events) =>
          Effect.gen(function* () {
            yield* bridge.type(':echomsg "first"<CR>');
            yield* bridge.type(':echomsg "second"<CR>');
            yield* bridge.type(":messages<CR>");
            yield* bridge.settle;

            const history = events.filter(
              (event) => event.kind === "message" && event.messageKind === "history",
            );
            const last = history[history.length - 1];
            const text = last?.kind === "message" ? last.text : "";
            // Neovim sends the whole history as one `msg_history_show`, not as a
            // run of `msg_show`s. A host that only knows the latter answers a
            // developer who asked for every message with nothing at all.
            assert.include(text, "first");
            assert.include(text, "second");
          }),
        ),
      ),
    );

    it.effect("reports the error a bad command produces", () =>
      withNvim(["one"], (bridge) =>
        collecting(bridge, (events) =>
          Effect.gen(function* () {
            yield* bridge.type(":nosuchcommand<CR>");
            yield* bridge.settle;
            const messages = events.filter((event) => event.kind === "message");
            assert.isTrue(
              messages.some(
                (event) =>
                  event.kind === "message" &&
                  event.text.includes("E492") &&
                  (event.messageKind === "emsg" || event.messageKind === "echoerr"),
              ),
              // The developer has to be told. Neovim's own answer is on a line
              // this host never draws, so an error swallowed here is an error
              // nobody ever sees.
              `an error message reached the bridge, saw ${messages.length} messages`,
            );
          }),
        ),
      ),
    );
  });

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("conformance: an agent's write", (it) => {
    it.effect("lands at UTF-16 columns on a line outside ASCII", () =>
      withNvim(["⚠️ café — ok"], (bridge) =>
        Effect.gen(function* () {
          // Monaco reports columns in UTF-16 units. "ok" starts at unit 10 and
          // at byte 16, so an edit read as bytes lands inside the em dash.
          yield* bridge.request("nvim_exec_lua", [
            APPLY_EDITS_LUA,
            [bridge.attachedBuffer, [[0, 10, 0, 12, ["OK"]]]],
          ]);
          yield* bridge.settle;
          assert.deepStrictEqual([...bridge.lines], ["⚠️ café — OK"]);
        }),
      ),
    );

    it.effect("is one undo step however many edits it carries", () =>
      withNvim(["alpha", "beta", "gamma"], (bridge) =>
        Effect.gen(function* () {
          // The developer has to be able to take somebody else's write back with
          // one `u`. Several edits sent as several calls are several undo
          // blocks, and undoing half of an agent's change looks exactly like
          // undoing all of it.
          yield* bridge.request("nvim_exec_lua", [
            APPLY_EDITS_LUA,
            [
              bridge.attachedBuffer,
              [
                [0, 0, 0, 5, ["ALPHA"]],
                [2, 0, 2, 5, ["GAMMA"]],
              ],
            ],
          ]);
          yield* bridge.settle;
          assert.deepStrictEqual(
            [...bridge.lines],
            ["ALPHA", "beta", "GAMMA"],
            "both edits landed",
          );

          yield* bridge.type("u");
          yield* bridge.settle;
          assert.deepStrictEqual(
            [...bridge.lines],
            ["alpha", "beta", "gamma"],
            "and one undo took the whole write back",
          );

          yield* bridge.type("<C-r>");
          yield* bridge.settle;
          assert.deepStrictEqual(
            [...bridge.lines],
            ["ALPHA", "beta", "GAMMA"],
            "redo reapplies it",
          );
        }),
      ),
    );

    it.effect("does not trust the order the edits arrive in", () =>
      withNvim(["abcdefghij"], (bridge) =>
        Effect.gen(function* () {
          // The later edit comes first and both change the line's length: applying them in array
          // order produced `XXXXXXZXdefghij`. Length-preserving edits would hide that defect.
          yield* bridge.request("nvim_exec_lua", [
            APPLY_EDITS_LUA,
            [
              bridge.attachedBuffer,
              [
                [0, 6, 0, 9, ["Z"]],
                [0, 0, 0, 3, ["XXXXXXXXXX"]],
              ],
            ],
          ]);
          yield* bridge.settle;
          assert.deepStrictEqual(
            [...bridge.lines],
            ["XXXXXXXXXXdefZj"],
            "both edits hit their own text",
          );

          yield* bridge.type("u");
          yield* bridge.settle;
          assert.deepStrictEqual(
            [...bridge.lines],
            ["abcdefghij"],
            "and it was still one undo step",
          );
        }),
      ),
    );

    it.effect("orders edits across lines, not only within one", () =>
      withNvim(["one", "two", "three"], (bridge) =>
        Effect.gen(function* () {
          // The first edit splits a line, so applying it early moves the second's target. The later
          // line carries the smaller column, so a sort on columns alone gets the order wrong and a
          // sort on lines first does not. Equal columns could not tell the two sorts apart.
          yield* bridge.request("nvim_exec_lua", [
            APPLY_EDITS_LUA,
            [
              bridge.attachedBuffer,
              [
                [0, 3, 0, 3, ["", ""]],
                [2, 0, 2, 5, ["THREE"]],
              ],
            ],
          ]);
          yield* bridge.settle;
          assert.deepStrictEqual([...bridge.lines], ["one", "", "two", "THREE"]);

          yield* bridge.type("u");
          yield* bridge.settle;
          assert.deepStrictEqual([...bridge.lines], ["one", "two", "three"]);
        }),
      ),
    );

    it.effect("applies two edits on one line, and an insertion", () =>
      withNvim(["alpha beta"], (bridge) =>
        Effect.gen(function* () {
          yield* bridge.request("nvim_exec_lua", [
            APPLY_EDITS_LUA,
            [
              bridge.attachedBuffer,
              [
                [0, 6, 0, 10, ["BETA"]],
                [0, 5, 0, 5, [" and"]],
              ],
            ],
          ]);
          yield* bridge.settle;
          assert.deepStrictEqual([...bridge.lines], ["alpha and BETA"]);
        }),
      ),
    );
  });

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("conformance: the viewport", (it) => {
    it.effect("holds the window where the client put it, with the cursor left behind", () =>
      withNvim(
        Array.from({ length: 200 }, (_, index) => `line ${index + 1}`),
        (bridge) =>
          Effect.gen(function* () {
            // The wheel scroll: the cursor is at the top and the view at line 50. Neovim snaps back
            // a window that hides the cursor, so `winrestview({ topline })` alone fails, and the
            // snap is invisible from inside the same Lua call.
            yield* bridge.request("nvim_ui_try_resize_grid", [2, 120, 10]);
            yield* bridge.request("nvim_exec_lua", [
              SET_VIEWPORT_LUA,
              [bridge.attachedBuffer, 50, 10],
            ]);
            yield* bridge.settle;

            const view = (yield* bridge.request("nvim_exec_lua", [
              "return vim.fn.winsaveview()",
              [],
            ])) as { topline: number; lnum: number };
            assert.strictEqual(view.topline, 50, "the window stayed where it was put");
            assert.isAtLeast(view.lnum, 50, "and the cursor came with it, as a wheel would");
            assert.isAtMost(view.lnum, 59);
          }),
      ),
    );

    it.effect("leaves the cursor alone when it is already in the window", () =>
      withNvim(
        Array.from({ length: 200 }, (_, index) => `line ${index + 1}`),
        (bridge) =>
          Effect.gen(function* () {
            yield* bridge.request("nvim_ui_try_resize_grid", [2, 120, 10]);
            yield* bridge.request("nvim_win_set_cursor", [0, [52, 2]]);
            yield* bridge.request("nvim_exec_lua", [
              SET_VIEWPORT_LUA,
              [bridge.attachedBuffer, 50, 10],
            ]);
            yield* bridge.settle;

            const cursor = (yield* bridge.request("nvim_win_get_cursor", [0])) as [number, number];
            assert.strictEqual(cursor[0], 52, "the caret did not move for a scroll it was inside");
            assert.strictEqual(cursor[1], 2, "and neither did its column");
          }),
      ),
    );

    it.effect("brings a cursor below the window up into it", () =>
      withNvim(
        Array.from({ length: 200 }, (_, index) => `line ${index + 1}`),
        (bridge) =>
          Effect.gen(function* () {
            // Scrolling up, away from a caret below the window: only `rows` says where the window
            // ends. A clamp on the buffer's last line leaves the cursor, and Neovim snaps back.
            yield* bridge.request("nvim_ui_try_resize_grid", [2, 120, 10]);
            yield* bridge.request("nvim_win_set_cursor", [0, [150, 0]]);
            yield* bridge.request("nvim_exec_lua", [
              SET_VIEWPORT_LUA,
              [bridge.attachedBuffer, 50, 10],
            ]);
            yield* bridge.settle;

            const view = (yield* bridge.request("nvim_exec_lua", [
              "return vim.fn.winsaveview()",
              [],
            ])) as { topline: number; lnum: number };
            assert.strictEqual(view.topline, 50, "the window went where it was asked");
            assert.isAtMost(view.lnum, 59, "and the caret came up to the bottom of it");
            assert.isAtLeast(view.lnum, 50);
          }),
      ),
    );

    it.effect("answers a topline the buffer cannot reach with one it can", () =>
      withNvim(["one", "two", "three"], (bridge) =>
        Effect.gen(function* () {
          // Behaviour worth pinning even though Neovim does the clamping rather
          // than this Lua: a client whose model has moved on can ask for any of
          // these, and what matters is that the answer is a line that exists.
          const toplineAfter = (topline: number) =>
            Effect.gen(function* () {
              yield* bridge.request("nvim_exec_lua", [
                SET_VIEWPORT_LUA,
                [bridge.attachedBuffer, topline, 10],
              ]);
              yield* bridge.settle;
              const view = (yield* bridge.request("nvim_exec_lua", [
                "return vim.fn.winsaveview()",
                [],
              ])) as { topline: number };
              return view.topline;
            });

          assert.strictEqual(yield* toplineAfter(500), 3, "past the end lands on the last line");
          assert.strictEqual(yield* toplineAfter(0), 1, "zero lands on the first");
          assert.strictEqual(yield* toplineAfter(-5), 1, "and so does a negative one");
        }),
      ),
    );

    it.effect("reports overlays against buffer lines, not grid rows", () =>
      withNvim(
        Array.from({ length: 200 }, (_, index) => `line ${index + 1} has a target here`),
        (bridge) =>
          Effect.gen(function* () {
            // A small window a long way down the file. Everything drawn is then
            // on grid rows 0..9 while the buffer lines are in the fifties, which
            // is the arrangement that makes an off-by-topline invisible in a
            // test that scrolls nowhere.
            yield* bridge.request("nvim_ui_try_resize_grid", [2, 120, 10]);
            yield* bridge.request("nvim_exec_lua", [
              "vim.fn.winrestview({ topline = 50, lnum = 50 })",
              [],
            ]);
            yield* bridge.settle;
            assert.strictEqual(bridge.topLine + 1, 50, "the window is where it was put");

            // Search highlighting draws over the text without changing it, which
            // is the cheapest overlay a stock Neovim produces.
            yield* bridge.type(":set hlsearch<CR>");
            yield* bridge.type("/target<CR>");
            yield* bridge.settle;

            const runs = bridge.highlightRuns;
            assert.isNotEmpty(runs, "something was drawn over the text");
            for (const run of runs) {
              assert.isAtLeast(run.line, 50, `a run on buffer line ${run.line}, not a grid row`);
              assert.isAtMost(run.line, 60, `a run on buffer line ${run.line}, not a grid row`);
            }
          }),
      ),
    );
  });

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("conformance: a substitute being typed", (it) => {
    /**
     * Live substitute preview must not move the mirror. With `inccommand=nosplit`, each keystroke
     * of a `:s` reports the same range against the untouched original; applied in order, these
     * non-composing events garble the line. The table's `substitute` case cannot catch this:
     * `type` runs the whole command at once, so Neovim never draws a preview.
     */
    it.effect("does not move the mirror until Enter", () =>
      withNvim(["one two", "three four"], (bridge) =>
        Effect.gen(function* () {
          for (const character of ":%s/two/TWO\\rMORE/") {
            yield* bridge.input(character);
          }
          // Neovim answering this at all proves it has read the keys, and the
          // preview events are emitted while it reads them. No clock involved.
          const mode = (yield* bridge.request("nvim_get_mode", [])) as { mode: string };
          assert.strictEqual(mode.mode, "c", "the command line is still open");

          const untouched = (yield* bridge.request("nvim_buf_get_lines", [
            0,
            0,
            -1,
            false,
          ])) as string[];
          assert.deepStrictEqual(untouched, ["one two", "three four"], "Neovim's own text");
          assert.deepStrictEqual([...bridge.lines], untouched, "and the mirror still agrees");

          yield* bridge.input("<CR>");
          yield* bridge.settle;

          const committed = (yield* bridge.request("nvim_buf_get_lines", [
            0,
            0,
            -1,
            false,
          ])) as string[];
          assert.deepStrictEqual(committed, ["one TWO", "MORE", "three four"], "the command ran");
          assert.deepStrictEqual([...bridge.lines], committed, "and the mirror followed it");
        }),
      ),
    );
  });

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("conformance: the mirror equals Neovim", (it) => {
    it.effect.each(KEYSTROKE_CASES)("$name", (keystrokeCase) =>
      withNvim(keystrokeCase.lines, (bridge) =>
        Effect.gen(function* () {
          for (const keys of keystrokeCase.keys) {
            yield* send(bridge, keys);
          }
          const expected = yield* truth(bridge);

          assert.deepStrictEqual(bridge.lines, expected.lines, "mirrored lines");
          assert.deepStrictEqual(bridge.cursor, expected.cursor, "cursor");
          assert.strictEqual(bridge.mode, expected.mode, "mode");
        }),
      ),
    );

    it.effect("finds overlaid virtual text as one overlay at the right column", () =>
      withNvim(["const value = 1;"], (bridge) =>
        Effect.gen(function* () {
          const namespace = (yield* bridge.request("nvim_create_namespace", [
            "mesura-test",
          ])) as number;
          yield* bridge.request("nvim_buf_set_extmark", [
            0,
            namespace,
            0,
            0,
            { virt_text: [["XY", "ErrorMsg"]], virt_text_pos: "overlay" },
          ]);
          yield* bridge.awaitFlush;

          // One overlay, not one per cell: each overlay is a node on the client,
          // and adjacent cells on one highlight are one piece of virtual text.
          const overlays = bridge.overlays;
          assert.deepStrictEqual(
            overlays.map((overlay) => [overlay.line, overlay.col, overlay.text]),
            [[1, 1, "XY"]],
          );
        }),
      ),
    );

    it.effect("keeps line numbers unshifted when virtual lines are drawn above", () =>
      withNvim(["one", "two", "three"], (bridge) =>
        Effect.gen(function* () {
          const namespace = (yield* bridge.request("nvim_create_namespace", [
            "mesura-test-2",
          ])) as number;
          yield* bridge.request("nvim_buf_set_extmark", [
            0,
            namespace,
            1,
            0,
            { virt_lines: [[["a drawn line", "Comment"]]], virt_lines_above: true },
          ]);
          yield* bridge.awaitFlush;
          yield* send(bridge, "G");

          const expected = yield* truth(bridge);
          assert.deepStrictEqual(bridge.cursor, expected.cursor);
          assert.strictEqual(bridge.lines.length, 3);
        }),
      ),
    );

    it.effect("reports its own exit, and a request after it fails instead of waiting", () =>
      withNvim(["one"], (bridge) =>
        Effect.gen(function* () {
          const exited = yield* Deferred.make<void>();
          bridge.subscribe((event) => {
            if (event.kind === "exited") Deferred.doneUnsafe(exited, Effect.void);
          });
          // What a developer typing `:qa!` into the editor does.
          yield* bridge.input(":qa!<CR>");
          yield* Deferred.await(exited);
          const after = yield* Effect.result(bridge.request("nvim_eval", ["1"]));
          assert.isTrue(Result.isFailure(after), "a request to an exited Neovim fails");
        }),
      ),
    );

    it.effect("stays on the file when Neovim moves to a buffer the host did not open", () =>
      withNvim(["first buffer"], (bridge) =>
        Effect.gen(function* () {
          // REGRESSION: this once asserted "follow the buffer switch", and the mirror followed a
          // plugin's prompt into a save that overwrote `apps/server/src/editor/hostPlugin.ts`. A
          // dashboard needs no following: `mesura.open` switches to a buffer the host marks. Both
          // halves of the rule are in `foreignBuffers.test.ts`.
          yield* bridge.request("nvim_command", ["enew"]);
          yield* bridge.settle;

          assert.deepStrictEqual(
            bridge.lines,
            ["first buffer"],
            "the mirror followed Neovim into a buffer the host never opened",
          );
        }),
      ),
    );

    it.effect("keeps following the buffer it has when an attach fails", () =>
      withNvim(["first buffer"], (bridge) =>
        Effect.gen(function* () {
          // The announced buffer is gone, so the attach fails, correctly. The mirror must keep the
          // buffer it follows: recording the new one before the attach succeeds points the mirror at
          // a buffer that never sends an event, and every later edit is dropped silently.
          const gone = (yield* bridge.request("nvim_exec_lua", [
            `local buffer = vim.api.nvim_create_buf(true, false)
           vim.api.nvim_buf_delete(buffer, { force = true })
           return buffer`,
            [],
          ])) as number;

          yield* bridge.request("nvim_exec_lua", [
            "vim.rpcnotify(vim.g.mesura_channel, 'mesura_buffer_changed', ...)",
            [gone],
          ]);
          yield* bridge.settle;

          yield* send(bridge, "A!");
          yield* send(bridge, "<Esc>");

          const expected = yield* truth(bridge);
          assert.deepStrictEqual(expected.lines, ["first buffer!"], "Neovim's own buffer");
          assert.deepStrictEqual(bridge.lines, ["first buffer!"], "the mirror");
        }),
      ),
    );

    it.effect("fails the settle when the host channel is gone, rather than waiting for ever", () =>
      withNvim(["one"], (bridge) =>
        Effect.gen(function* () {
          // `settle` waits for a notification it asks Neovim to send back. If the
          // channel it names is not there, the notification is never sent and
          // nothing arrives — so the wait has to be a failure rather than a
          // silence. A hung settle stops a whole session with no message.
          yield* bridge.request("nvim_command", ["unlet g:mesura_channel"]);

          const outcome = yield* bridge.settle.pipe(Effect.result);
          assert.isTrue(Result.isFailure(outcome), "the settle reported the missing channel");

          // And the session is still usable afterwards: the failure is the
          // settle's, not the bridge's.
          yield* bridge.request("nvim_exec_lua", ["vim.g.mesura_channel = ...", [1]]);
          yield* send(bridge, "A!");
          yield* send(bridge, "<Esc>");
          assert.deepStrictEqual(bridge.lines, ["one!"]);
        }),
      ),
    );

    it.effect("drops no character under fifty insert-mode keystrokes", () =>
      withNvim([""], (bridge) =>
        Effect.gen(function* () {
          const typed = Array.from({ length: 50 }, (_, index) => String(index % 10)).join("");

          // `input` per character, because per-key delivery is the subject: `type` sends one call,
          // and its `x` flag aborts a lone `i` before insert mode. Settling on the frame is sound
          // only here: an insert-mode character always redraws, and `--clean` draws nothing else.
          yield* bridge.input("i");
          yield* bridge.awaitFlush;
          for (const character of typed) {
            yield* bridge.input(character);
            yield* bridge.awaitFlush;
          }
          yield* bridge.input("<Esc>");
          yield* bridge.awaitFlush;

          const expected = yield* truth(bridge);
          assert.deepStrictEqual(expected.lines, [typed], "Neovim's own buffer");
          assert.deepStrictEqual(bridge.lines, [typed], "the mirror");
        }),
      ),
    );

    it.effect("records the protocol floor and the per-key latency spread", () =>
      withNvim(
        Array.from({ length: 40 }, (_, index) => `line ${index}`),
        (bridge) =>
          Effect.gen(function* () {
            const normal: number[] = [];
            for (let index = 0; index < 20; index += 1) {
              // Alternating, because a key that changes nothing draws nothing:
              // `j` on the last line produces no redraw, so a probe waiting for
              // the flush it caused would wait for a frame that never comes.
              normal.push(yield* bridge.floorProbe(index % 2 === 0 ? "j" : "k"));
            }
            yield* send(bridge, "GA");
            const insert: number[] = [];
            for (let index = 0; index < 20; index += 1) {
              insert.push(yield* bridge.floorProbe("x"));
            }
            yield* send(bridge, "<Esc>");

            const at = (samples: number[], quantile: number) => {
              const sorted = [...samples].sort((left, right) => left - right);
              return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
            };
            // Printed rather than asserted against a threshold: the number is the
            // input to phase 3's decision, and a threshold here would make the
            // harness fail on a loaded machine for no defect.
            yield* Effect.logInfo("conformance latency", {
              normalP50: at(normal, 0.5),
              normalP95: at(normal, 0.95),
              insertP50: at(insert, 0.5),
              insertP95: at(insert, 0.95),
            });

            assert.isAbove(normal.length, 0);
            assert.isAbove(at(normal, 0.5), 0, "the floor is a real measurement");
          }),
      ),
    );
  });
