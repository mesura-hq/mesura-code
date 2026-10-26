import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { makeNvimRpc, packNvimFrame, type NvimRpcDuplex } from "./NvimRpc.ts";

/**
 * A response frame carrying the three handle types, as hand-written msgpack extension bytes.
 * Bytes packed by this code agreed with a codec registered under the wrong key.
 */
const HANDLE_RESPONSE_BYTES = new Uint8Array([
  0x94, // response frame: kind 1, message id 0, no error, array of 3 results
  0x01,
  0x00,
  0xc0,
  0x93,
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

  it.effect("fails waiting and later requests when reading the channel fails", () =>
    Effect.gen(function* () {
      const inbound = yield* Queue.make<Uint8Array, string>();
      const rpc = yield* makeNvimRpc({ write: () => undefined, data: Stream.fromQueue(inbound) });

      const pending = yield* Effect.forkChild(Effect.result(rpc.request("nvim_get_mode", [])));
      yield* Effect.yieldNow;
      // A pipe that errors rather than ends, which is not the process exiting
      // cleanly but leaves nothing to answer either.
      yield* Queue.fail(inbound, "EIO");

      assert.isTrue(Result.isFailure(yield* Fiber.join(pending)), "the waiting request fails");
      const later = yield* Effect.result(rpc.request("nvim_get_mode", []));
      assert.isTrue(Result.isFailure(later), "and so does the next one, at once");
    }).pipe(Effect.scoped),
  );

  it.effect("fails rather than wedges on a frame it cannot read at all", () =>
    Effect.gen(function* () {
      const { duplex, inbound } = yield* fakeDuplex;
      const rpc = yield* makeNvimRpc(duplex);

      const pending = yield* Effect.forkChild(Effect.result(rpc.request("nvim_get_mode", [])));
      yield* Effect.yieldNow;

      // An unregistered extension type. Unlike a short frame, which the next read completes,
      // this one can never be read: kept at the head of the tail, it would stall the channel
      // silently and forever, so the channel fails instead.
      yield* Queue.offer(inbound, new Uint8Array([0x94, 0x01, 0x00, 0xc0, 0xd4, 0x09, 0x01]));

      const settled = yield* Fiber.join(pending);
      assert.isTrue(Result.isFailure(settled), "the in-flight request is failed, not abandoned");
    }).pipe(Effect.scoped),
  );
});
