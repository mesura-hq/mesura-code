// @effect-diagnostics nodeBuiltinImport:off - locates the real nvim binary before spawning it.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
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
    // Drained before the body starts. Seeding the buffer draws frames, those
    // frames trigger their own forked cursor read, and a `cursor` event still
    // in flight from the setup would otherwise satisfy the first key's wait —
    // resolving it against the cursor as it was before the key.
    yield* bridge.settle;
    return yield* body(bridge);
  }).pipe(Effect.scoped);

const A_FEW_LINES = ["one", "two", "three", "four", "five"];

/**
 * Sends a key and waits for the cursor the session read because of it.
 *
 * The read is forked off the notification fiber on purpose — awaiting an RPC
 * there stops every other notification queued behind it, and Neovim does not
 * always answer — so the cursor lands on a frame *after* the one the key drew.
 * The `cursor` event is what says the read has landed. Counting frames would
 * not do: Neovim sends several redraw batches for one key, so any fixed number
 * is a guess that passes for the wrong reason.
 *
 * Waiting on the drawing frame instead asserts against the cursor as it was
 * *before* the key, which is exactly the defect this file exists to catch.
 */
const pressAndSettle = (bridge: NvimBridge.Session, keys: string) =>
  Effect.gen(function* () {
    const echoed = yield* Deferred.make<void>();
    const stop = bridge.subscribe((event) => {
      if (event.kind !== "cursor") return;
      Deferred.doneUnsafe(echoed, Effect.void);
    });
    yield* bridge.input(keys);
    yield* Deferred.await(echoed);
    stop();
  });

it.layer(layer)("the cursor a key moved", (it) => {
  it.effect.skipIf(!nvimAvailable)("is what the session reports after `j`", () =>
    withNvim(A_FEW_LINES, (bridge) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(bridge.cursor, { line: 1, col: 1 });

        // Exactly what a keystroke does: send it, then wait for the drawing it
        // caused. Nothing here asks Neovim where the cursor is, because the
        // path a person types does not either.
        yield* pressAndSettle(bridge, "j");

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
        yield* pressAndSettle(bridge, "<Down>");

        assert.deepStrictEqual(bridge.cursor, { line: 2, col: 1 });
      }),
    ),
  );

  it.effect.skipIf(!nvimAvailable)("follows the mode into insert, having moved nothing", () =>
    withNvim(A_FEW_LINES, (bridge) =>
      Effect.gen(function* () {
        assert.strictEqual(bridge.mode, "n");

        // `i` at the first column is the case the cursor counter cannot see:
        // the caret does not move, no text changes, and the only thing that
        // happened is a mode change. Without `mode_change` in the trigger the
        // strip goes on saying NORMAL while every key types a letter.
        yield* pressAndSettle(bridge, "i");

        assert.strictEqual(bridge.mode, "i", "the strip would still read NORMAL in insert mode");

        // Leaving insert again is deliberately not asserted here. It needs a
        // second key in one session, and the first key's trailing frames
        // trigger their own read whose `cursor` event satisfies the second
        // key's wait before the second key has been drawn — a test that passes
        // or fails on timing. `bridge.type` cannot set the state up either:
        // it feeds keys with `nvim_feedkeys`'s `x` flag, which ends insert
        // mode the way `:normal! i` does. The trigger itself is held per case
        // in `NvimBridge.test.ts`, which is where that coverage belongs.
      }),
    ),
  );

  it.effect.skipIf(!nvimAvailable)("is what the session reports after `l`", () =>
    withNvim(A_FEW_LINES, (bridge) =>
      Effect.gen(function* () {
        yield* pressAndSettle(bridge, "l");

        // One column right, in the one-based columns the wire uses.
        assert.deepStrictEqual(bridge.cursor, { line: 1, col: 2 });
      }),
    ),
  );
});
