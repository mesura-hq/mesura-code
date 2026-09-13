// @effect-diagnostics nodeBuiltinImport:off - locates the real nvim binary before spawning it.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { NvimBridge, type NvimBridgeError } from "../NvimBridge.ts";

/**
 * A plain cursor motion has to reach the client.
 *
 * `h`, `j`, `k`, `l` and the arrow keys move the cursor and nothing else: no
 * text changes, and on a file taller than the window no line scrolls either.
 * That makes them the one motion whose only evidence is the cursor, and it is
 * why they were the thing that turned out not to work while `G` and `:` looked
 * fine — those two move the viewport and the command line, which travel on
 * their own events.
 *
 * The session's `cursor` is what the manager publishes from, and it compares
 * the value against the last one it sent. A cursor that is never re-read after
 * a key therefore compares equal to itself forever, and the manager stays
 * silent while Neovim's caret walks down the file.
 *
 * `input` is the call under test, not `type`. They settle differently, and
 * `input` is the one a keystroke goes through.
 */

const nvimAvailable = (() => {
  try {
    NodeChildProcess.execFileSync("nvim", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

const withNvim = <A>(
  lines: ReadonlyArray<string>,
  body: (bridge: NvimBridge.Session) => Effect.Effect<A, NvimBridgeError, never>,
) =>
  Effect.gen(function* () {
    const bridge = yield* NvimBridge.spawn({ cols: 80, rows: 24 });
    yield* bridge.setLines(lines);
    return yield* body(bridge);
  }).pipe(Effect.scoped);

const A_FEW_LINES = ["one", "two", "three", "four", "five"];

it.layer(layer)("the cursor a key moved", (it) => {
  it.effect.skipIf(!nvimAvailable)("is what the session reports after `j`", () =>
    withNvim(A_FEW_LINES, (bridge) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(bridge.cursor, { line: 1, col: 1 });

        // Exactly what a keystroke does: send it, then wait for the drawing it
        // caused. Nothing here asks Neovim where the cursor is, because the
        // path a person types does not either.
        const frame = yield* bridge.nextFrame;
        yield* bridge.input("j");
        yield* frame;

        assert.deepStrictEqual(
          bridge.cursor,
          { line: 2, col: 1 },
          "a `j` moved Neovim's caret and the session still reports the old line, so the manager has nothing to publish and the client's caret never moves",
        );
      }),
    ),
  );

  it.effect.skipIf(!nvimAvailable)("is what the session reports after `<Down>`", () =>
    withNvim(A_FEW_LINES, (bridge) =>
      Effect.gen(function* () {
        const frame = yield* bridge.nextFrame;
        yield* bridge.input("<Down>");
        yield* frame;

        assert.deepStrictEqual(bridge.cursor, { line: 2, col: 1 });
      }),
    ),
  );

  it.effect.skipIf(!nvimAvailable)("follows the mode when a key changes it and moves nothing", () =>
    withNvim(A_FEW_LINES, (bridge) =>
      Effect.gen(function* () {
        assert.strictEqual(bridge.mode, "n");

        // `i` at the first column is the case the cursor counter cannot see:
        // the caret does not move, no text changes, and the only thing that
        // happened is a mode change. Without `mode_change` in the trigger the
        // strip goes on saying NORMAL while every key types a letter.
        const entered = yield* bridge.nextFrame;
        yield* bridge.input("i");
        yield* entered;
        assert.strictEqual(bridge.mode, "i", "the strip would still read NORMAL in insert mode");

        const left = yield* bridge.nextFrame;
        yield* bridge.input("<Esc>");
        yield* left;
        assert.strictEqual(bridge.mode, "n");
      }),
    ),
  );

  it.effect.skipIf(!nvimAvailable)("moves the cursor and the viewport for `<C-d>`", () =>
    withNvim(
      Array.from({ length: 100 }, (_, index) => `line ${String(index + 1)}`),
      (bridge) =>
        Effect.gen(function* () {
          const before = bridge.topLine;

          const frame = yield* bridge.nextFrame;
          yield* bridge.input("<C-d>");
          yield* frame;

          // A half-page scroll moves both. The viewport travels on its own
          // event, so this half was never broken; the cursor is the half that
          // made the key feel dead.
          assert.isAbove(bridge.cursor.line, 1, "`<C-d>` did not move the cursor");
          assert.isAbove(bridge.topLine, before, "`<C-d>` did not scroll the window");
        }),
    ),
  );

  it.effect.skipIf(!nvimAvailable)("is what the session reports after `l`", () =>
    withNvim(A_FEW_LINES, (bridge) =>
      Effect.gen(function* () {
        const frame = yield* bridge.nextFrame;
        yield* bridge.input("l");
        yield* frame;

        // One column right, in the one-based columns the wire uses.
        assert.deepStrictEqual(bridge.cursor, { line: 1, col: 2 });
      }),
    ),
  );
});
