// @effect-diagnostics nodeBuiltinImport:off - locates the real nvim binary before spawning it.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
 * Sends keys and waits for the redraw they cause, never for a clock.
 *
 * Every sequence here must actually change the screen. A key that changes
 * nothing produces no redraw, so waiting for one waits forever — which is why
 * a no-op `gg` at the top of a buffer does not belong in a case.
 */
const send = (bridge: NvimBridge.Session, keys: string) =>
  Effect.gen(function* () {
    yield* bridge.input(keys);
    yield* bridge.awaitFlush;
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
  // The cursor already sits on line 1, so `gg` is left out: a key that changes
  // nothing draws nothing, and `send` waits for the frame a key caused.
  { name: "dG from the top empties the buffer the same way", lines: ["a", "b"], keys: ["dG"] },
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

  it.effect("drops no character under fifty insert-mode keystrokes", () =>
    withNvim([""], (bridge) =>
      Effect.gen(function* () {
        const typed = Array.from({ length: 50 }, (_, index) => String(index % 10)).join("");
        yield* send(bridge, "i");
        for (const character of typed) {
          yield* send(bridge, character);
        }
        yield* send(bridge, "<Esc>");

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
