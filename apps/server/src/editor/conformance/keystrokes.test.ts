// @effect-diagnostics nodeBuiltinImport:off - locates the real nvim binary before spawning it.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { NvimAdapter } from "../NvimAdapter.ts";
import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { APPLY_EDITS_LUA, SET_VIEWPORT_LUA } from "../hostPlugin.ts";
import { NvimBridge, type NvimBridgeError, type NvimBridgeEvent } from "../NvimBridge.ts";

/**
 * The conformance harness.
 *
 * It drives a real `nvim --embed --clean` and asserts that the bridge's mirror
 * is what Neovim itself reports, after each of a spread of key sequences. Zed
 * and JetBrains both run one of these in continuous integration for the same
 * reason: text sync is the subsystem that fails silently, and a mirror that has
 * drifted looks exactly like a mirror that has not until somebody saves.
 *
 * Every wait here is on a `flush`, a buffer-lines event, or an RPC response.
 * A sleep would make the harness pass for the wrong reason on a fast machine.
 */

const nvimAvailable = (() => {
  try {
    NodeChildProcess.execFileSync("nvim", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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
 * Types keys and returns once Neovim has executed them, never waiting on a
 * clock.
 *
 * `type` rather than `input`: `nvim_input` is asynchronous and nothing says
 * when it has been consumed, so a harness built on it asserts against whatever
 * state happens to exist. `awaitFlush` is not the answer either — waiting for
 * the next frame assumes the key is the only thing drawing, which holds for
 * `--clean` and fails the moment a real configuration is loaded.
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
    return { lines, cursor: { line: cursor[0], col: cursor[1] + 1 }, mode: mode.mode };
  });

/** One case of the keystroke table. */
interface KeystrokeCase {
  readonly name: string;
  readonly lines: ReadonlyArray<string>;
  readonly keys: ReadonlyArray<string>;
}

const KEYSTROKE_CASES: ReadonlyArray<KeystrokeCase> = [
  { name: "j moves down", lines: ["one", "two", "three"], keys: ["j"] },
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

if (!nvimAvailable) {
  // A machine with no Neovim is a real case — continuous integration is one —
  // and a silently absent suite is worse than one that says why it is absent.
  it("skips the conformance harness, because nvim is not on PATH", () => {
    assert.isFalse(nvimAvailable);
  });
}

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
      // Driven against the real spawner, because the thing that was wrong was
      // what the platform layer's error looks like. A classifier tested
      // against a string somebody wrote by hand is a classifier tested against
      // a guess: this one matched `ENOENT` and `not found`, and Effect says
      // `NotFound`, so every missing Neovim was reported as a plain failure
      // and the developer was told to fix something else.
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

it.layer(layer, { excludeTestServices: true })("conformance: the command line", (it) => {
  if (!nvimAvailable) return;

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

it.layer(layer, { excludeTestServices: true })("conformance: an agent's write", (it) => {
  if (!nvimAvailable) return;

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
        assert.deepStrictEqual([...bridge.lines], ["ALPHA", "beta", "GAMMA"], "both edits landed");

        yield* bridge.type("u");
        yield* bridge.settle;
        assert.deepStrictEqual(
          [...bridge.lines],
          ["alpha", "beta", "gamma"],
          "and one undo took the whole write back",
        );

        yield* bridge.type("<C-r>");
        yield* bridge.settle;
        assert.deepStrictEqual([...bridge.lines], ["ALPHA", "beta", "GAMMA"], "redo reapplies it");
      }),
    ),
  );

  it.effect("does not trust the order the edits arrive in", () =>
    withNvim(["abcdefghij"], (bridge) =>
      Effect.gen(function* () {
        // Measured: the late edit listed first, and both edits changing the
        // line's length. An earlier version applied them in array order from
        // the end and produced `XXXXXXZXdefghij` — the second edit's columns
        // read against text the first had already moved. Length-preserving
        // edits hide this completely, which is why this case changes lengths.
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
        assert.deepStrictEqual([...bridge.lines], ["abcdefghij"], "and it was still one undo step");
      }),
    ),
  );

  it.effect("orders edits across lines, not only within one", () =>
    withNvim(["one", "two", "three"], (bridge) =>
      Effect.gen(function* () {
        // Two edits on different lines, and the first one splits a line, so
        // applying it early moves the second one's target. The columns are
        // deliberately opposed to the lines — the later line carries the
        // smaller column — because a sort that compares only columns then puts
        // them in exactly the wrong order, and one that compares lines first
        // does not. An earlier version of this guard put both edits at column
        // zero and could not tell the two sorts apart at all.
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

it.layer(layer, { excludeTestServices: true })("conformance: the viewport", (it) => {
  if (!nvimAvailable) return;

  it.effect("holds the window where the client put it, with the cursor left behind", () =>
    withNvim(
      Array.from({ length: 200 }, (_, index) => `line ${index + 1}`),
      (bridge) =>
        Effect.gen(function* () {
          // The wheel-scroll case, and the one that does not work with
          // `winrestview({ topline })` alone: the cursor is at the top of the
          // file and the developer is looking at line 50. Neovim refuses to
          // hold a window that hides the cursor, so the view snapped straight
          // back — and the snap is invisible from inside the same Lua call,
          // which is what made it survive a first round of testing.
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
          // The mirror of the case above, and the one that needs the window's
          // height: the developer scrolls *up*, away from a caret that is now
          // below what they can see. Only `rows` says where the window ends,
          // so a clamp that used the buffer's last line instead would leave
          // the cursor where it was and let Neovim snap the view back.
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

it.layer(layer, { excludeTestServices: true })("conformance: a substitute being typed", (it) => {
  if (!nvimAvailable) return;

  /**
   * Live substitute preview must not move the mirror.
   *
   * `inccommand` defaults to `nosplit`, so while a `:s` command is being typed
   * Neovim reports what each line *would* become — on every keystroke of the
   * replacement, every one of them describing the same range against the
   * original text, and with the buffer itself untouched throughout. They are
   * not deltas and they do not compose: applied in order they turn one line
   * into a growing pile of half-typed fragments.
   *
   * The table above cannot catch this, and that is worth saying out loud. Its
   * `substitute` case types the whole command through `type`, which runs it in
   * one go, so no preview is ever generated. Only typing it the way a person
   * does produces one.
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

it.layer(layer, { excludeTestServices: true })("conformance: the mirror equals Neovim", (it) => {
  if (!nvimAvailable) return;
  for (const keystrokeCase of KEYSTROKE_CASES) {
    it.effect(keystrokeCase.name, () =>
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
  }

  it.effect("finds overlaid virtual text as virtual cells at the right columns", () =>
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

        const overlays = bridge.overlays;
        assert.deepStrictEqual(
          overlays.map((overlay) => [overlay.line, overlay.col, overlay.text]),
          [
            [1, 1, "X"],
            [1, 2, "Y"],
          ],
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

  it.effect("stays on the file when Neovim moves to a buffer the host did not open", () =>
    withNvim(["first buffer"], (bridge) =>
      Effect.gen(function* () {
        // REGRESSION. This asserted the opposite until it destroyed a file.
        //
        // The old rule was "follow the buffer switch", written for a real
        // configuration that starts on a dashboard, with `:enew` standing in
        // for that move. It is the wrong rule, because the announcement a
        // dashboard makes is the announcement every plugin makes: a picker, a
        // git status, a prompt, a terminal. Following it means the mirror
        // holds a plugin's window, the client renders that as the file, and
        // the next save writes it to disk.
        //
        // Measured in the running app against the developer's configuration:
        // `<C-e>` put a git-status window in the panel and `<C-f>` put a
        // one-line prompt holding a single emoji there.
        // `apps/server/src/editor/hostPlugin.ts` became that emoji, five bytes
        // on disk.
        //
        // The dashboard case needs no following at all: the host opens the
        // file with `mesura.open`, which switches to a buffer the host owns
        // and marks, and that switch is announced and followed. See
        // `foreignBuffers.test.ts` for both halves of the rule.
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
        // An announcement naming a buffer that is not there. The attach fails,
        // and failing is right — the buffer really is gone. What must not
        // happen is the mirror giving up the buffer it was already following:
        // recording the new buffer before the attach succeeded detaches from
        // the good one and then leaves the mirror pointed at a buffer that
        // will never send an event, so every later edit is dropped and the
        // text goes stale with nothing reporting it.
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

        // `input` one character at a time, because per-key delivery is the
        // whole subject here and `type` would defeat it twice over: it sends
        // the sequence in one call, and its `x` flag aborts an incomplete
        // command, so a lone `i` never reaches insert mode at all. Settling on
        // the frame is sound in this file and only in this file — a character
        // typed in insert mode always redraws, and `--clean` has nothing else
        // drawing to be confused with.
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
