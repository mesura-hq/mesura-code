import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { NvimBridge, type NvimBridgeError } from "../NvimBridge.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * `h`, `j`, `k`, `l` and the arrows change only the cursor, so the session's `cursor` is their only
 * evidence. The manager publishes `cursor` only when it differs from the last one sent, so a cursor
 * never re-read after a key keeps the client's caret still. `input` is the call under test, not
 * `type`: they settle differently, and a keystroke goes through `input`.
 */

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
 * Waits for the `cursor` event, not a frame: the session forks the cursor read off the notification
 * fiber, so it lands after the frame the key drew. Neovim sends several redraw batches per key, so
 * a frame count is a guess, and waiting on the drawing frame asserts the cursor from before the key.
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

if (!nvimAvailable) reportMissingNvim("cursor-echo harness");

if (nvimAvailable)
  it.layer(layer)("the cursor a key moved", (it) => {
    it.effect("is what the session reports after `j`", () =>
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

    it.effect("is what the session reports after `<Down>`", () =>
      withNvim(A_FEW_LINES, (bridge) =>
        Effect.gen(function* () {
          yield* pressAndSettle(bridge, "<Down>");

          assert.deepStrictEqual(bridge.cursor, { line: 2, col: 1 });
        }),
      ),
    );

    it.effect("follows the mode into insert, having moved nothing", () =>
      withNvim(A_FEW_LINES, (bridge) =>
        Effect.gen(function* () {
          assert.strictEqual(bridge.mode, "n");

          // `i` at the first column is the case the cursor counter cannot see:
          // the caret does not move, no text changes, and the only thing that
          // happened is a mode change. Without `mode_change` in the trigger the
          // strip goes on saying NORMAL while every key types a letter.
          yield* pressAndSettle(bridge, "i");

          assert.strictEqual(bridge.mode, "i", "the strip would still read NORMAL in insert mode");

          // Leaving insert is not asserted here: the first key's trailing `cursor` event would
          // satisfy a second key's wait early, and `bridge.type` (`nvim_feedkeys` flag `x`) ends
          // insert mode itself. `NvimBridge.test.ts` holds the `mode_change` trigger per case.
        }),
      ),
    );

    it.effect("is what the session reports after `l`", () =>
      withNvim(A_FEW_LINES, (bridge) =>
        Effect.gen(function* () {
          yield* pressAndSettle(bridge, "l");

          // One column right, in the one-based columns the wire uses.
          assert.deepStrictEqual(bridge.cursor, { line: 1, col: 2 });
        }),
      ),
    );
  });
