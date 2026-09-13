import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { makeNvimRpc, packNvimFrame, type NvimRpcDuplex } from "./NvimRpc.ts";

/**
 * A response frame carrying the three handle types, as real msgpack extension
 * bytes rather than as objects this code packed itself.
 *
 * Written by hand on purpose. An earlier version of this test packed a plain
 * object and asserted it came back, which agreed with itself and proved
 * nothing: the extension codec was registered under the wrong key the whole
 * time, and the first real handle from Neovim — the answer to
 * `nvim_get_current_buf` — threw inside the decoder and hung the call.
 */
const HANDLE_RESPONSE_BYTES = new Uint8Array([
  0x94, // array of 4: a response frame
  0x01, // kind: response
  0x00, // message id 0
  0xc0, // no error
  0x93, // array of 3 results
  0xd4,
  0x00,
  0x01, // fixext1, type 0 (Buffer), payload: fixint 1
  0xc7,
  0x03,
  0x01,
  0xcd,
  0x03,
  0xe8, // ext8 len 3, type 1 (Window), payload: uint16 1000
  0xd4,
  0x02,
  0x02, // fixext1, type 2 (Tabpage), payload: fixint 2
]);

/**
 * A duplex whose write side is captured and whose read side is fed by hand, so
 * the framing can be exercised with no Neovim anywhere near it.
 */
const fakeDuplex = Effect.gen(function* () {
  const written: Uint8Array[] = [];
  const inbound = yield* Queue.make<Uint8Array>();
  const duplex: NvimRpcDuplex = {
    write: (bytes) => {
      written.push(bytes);
    },
    data: Stream.fromQueue(inbound),
  };
  return { duplex, written, inbound };
});

describe("NvimRpc", () => {
  it.effect("answers a request with the result carried on its response frame", () =>
    Effect.gen(function* () {
      const { duplex, written, inbound } = yield* fakeDuplex;
      const rpc = yield* makeNvimRpc(duplex);

      const pending = yield* Effect.forkChild(rpc.request("nvim_get_mode", []));
      // The request is framed before anything answers it.
      yield* Effect.yieldNow;
      assert.strictEqual(written.length, 1);

      yield* Queue.offer(inbound, packNvimFrame([1, 0, null, { mode: "n", blocking: false }]));
      const result = yield* Fiber.join(pending);

      assert.deepStrictEqual(result, { mode: "n", blocking: false });
    }).pipe(Effect.scoped),
  );

  it.effect("fails the request when the response frame carries an error", () =>
    Effect.gen(function* () {
      const { duplex, inbound } = yield* fakeDuplex;
      const rpc = yield* makeNvimRpc(duplex);

      const pending = yield* Effect.forkChild(Effect.result(rpc.request("nvim_bogus", [])));
      yield* Effect.yieldNow;
      yield* Queue.offer(inbound, packNvimFrame([1, 0, [0, "Unknown function"], null]));

      const outcome = yield* Fiber.join(pending);
      assert.isTrue(Result.isFailure(outcome), "the request fails when Neovim reports an error");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps two in-flight requests apart by message id", () =>
    Effect.gen(function* () {
      const { duplex, inbound } = yield* fakeDuplex;
      const rpc = yield* makeNvimRpc(duplex);

      const first = yield* Effect.forkChild(rpc.request("a", []));
      const second = yield* Effect.forkChild(rpc.request("b", []));
      yield* Effect.yieldNow;

      // Answered out of order on purpose.
      yield* Queue.offer(inbound, packNvimFrame([1, 1, null, "second"]));
      yield* Queue.offer(inbound, packNvimFrame([1, 0, null, "first"]));

      assert.strictEqual(yield* Fiber.join(second), "second");
      assert.strictEqual(yield* Fiber.join(first), "first");
    }).pipe(Effect.scoped),
  );

  it.effect("publishes notifications, which carry no message id", () =>
    Effect.gen(function* () {
      const { duplex, inbound } = yield* fakeDuplex;
      const rpc = yield* makeNvimRpc(duplex);

      const collected = yield* Effect.forkChild(
        rpc.notifications.pipe(Stream.take(1), Stream.runCollect),
      );
      yield* Effect.yieldNow;
      yield* Queue.offer(inbound, packNvimFrame([2, "redraw", [["flush"]]]));

      const [event] = yield* Fiber.join(collected);
      assert.strictEqual(event?.method, "redraw");
    }).pipe(Effect.scoped),
  );

  it.effect("reassembles a frame split across two reads", () =>
    Effect.gen(function* () {
      const { duplex, inbound } = yield* fakeDuplex;
      const rpc = yield* makeNvimRpc(duplex);

      const pending = yield* Effect.forkChild(rpc.request("nvim_get_mode", []));
      yield* Effect.yieldNow;

      // A socket splits wherever it likes; the tail has to be kept.
      const frame = packNvimFrame([1, 0, null, "whole"]);
      const cut = Math.max(1, Math.floor(frame.length / 2));
      yield* Queue.offer(inbound, frame.subarray(0, cut));
      yield* Queue.offer(inbound, frame.subarray(cut));

      assert.strictEqual(yield* Fiber.join(pending), "whole");
    }).pipe(Effect.scoped),
  );

  it.effect("decodes the Buffer, Window and Tabpage extension types to handles", () =>
    Effect.gen(function* () {
      const { duplex, inbound } = yield* fakeDuplex;
      const rpc = yield* makeNvimRpc(duplex);

      // Without the extension registration the decoder throws on the first
      // `win_pos` event, which is the very first thing a UI attach produces.
      const pending = yield* Effect.forkChild(rpc.request("nvim_list_bufs", []));
      yield* Effect.yieldNow;
      yield* Queue.offer(inbound, HANDLE_RESPONSE_BYTES);

      const handles = (yield* Fiber.join(pending)) as ReadonlyArray<{
        kind: string;
        id: number;
      }>;
      assert.deepStrictEqual(
        handles.map((handle) => [handle.kind, handle.id]),
        [
          ["buffer", 1],
          ["window", 1000],
          ["tabpage", 2],
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails rather than wedges on a frame it cannot read at all", () =>
    Effect.gen(function* () {
      const { duplex, inbound } = yield* fakeDuplex;
      const rpc = yield* makeNvimRpc(duplex);

      const pending = yield* Effect.forkChild(Effect.result(rpc.request("nvim_get_mode", [])));
      yield* Effect.yieldNow;

      // An extension type nobody registered. This is not a hypothetical: the
      // handle codec was registered under the wrong key while this bridge was
      // being built, and every real handle from Neovim threw here.
      //
      // The distinction that matters is against a frame that is merely short.
      // A short frame completes on the next read, so it is kept and waited on.
      // One that can never be read would sit at the head of the tail forever:
      // every later chunk is appended behind it, no response or notification is
      // ever delivered again, and the tail grows without bound — a silent,
      // permanent stall. So it fails the channel instead.
      yield* Queue.offer(inbound, new Uint8Array([0x94, 0x01, 0x00, 0xc0, 0xd4, 0x09, 0x01]));

      const settled = yield* Fiber.join(pending);
      assert.isTrue(Result.isFailure(settled), "the in-flight request is failed, not abandoned");
    }).pipe(Effect.scoped),
  );
});
