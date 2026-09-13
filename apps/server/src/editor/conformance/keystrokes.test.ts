// @effect-diagnostics nodeBuiltinImport:off - locates the real nvim binary before spawning it.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { NvimBridge, type NvimBridgeError } from "../NvimBridge.ts";

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

  it.effect("follows a buffer switch instead of mirroring the buffer it left", () =>
    withNvim(["first buffer"], (bridge) =>
      Effect.gen(function* () {
        // A session does not stay on the buffer it attached to. Under a real
        // configuration it starts on a dashboard; here `:enew` stands in for
        // the same move. A mirror that does not follow reads the old buffer's
        // text for the rest of the session and nothing reports it.
        yield* bridge.request("nvim_command", ["enew"]);
        yield* bridge.settle;
        const now = yield* bridge.request("nvim_exec_lua", [
          "return vim.api.nvim_get_current_buf()",
          [],
        ]);
        require("node:fs").appendFileSync("/tmp/probe-attach.txt", `after-enew=${now}\n`);
        yield* bridge.setLines(["second buffer"]);
        yield* send(bridge, "A!");
        yield* send(bridge, "<Esc>");

        const expected = yield* truth(bridge);
        assert.deepStrictEqual(expected.lines, ["second buffer!"], "Neovim's own buffer");
        assert.deepStrictEqual(bridge.lines, ["second buffer!"], "the mirror");
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
