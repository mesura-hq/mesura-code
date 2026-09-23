import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Packr, Unpackr, addExtension } from "msgpackr";

/**
 * Neovim's msgpack-RPC framing, and nothing else.
 *
 * Written here rather than taken from the `neovim` npm package for two reasons
 * the prototype ran into. That package pulls `winston` into the server, and it
 * routes `nvim_buf_lines_event` to `Buffer` objects instead of to the generic
 * notification listener — which is exactly the incremental text path this
 * bridge is built on, so the one event that matters most would arrive somewhere
 * this code cannot see it.
 */

/** The three handle kinds Neovim sends as msgpack extension types. */
export const NVIM_HANDLE_KINDS = {
  buffer: "buffer",
  window: "window",
  tabpage: "tabpage",
} as const;

export type NvimHandleKind = (typeof NVIM_HANDLE_KINDS)[keyof typeof NVIM_HANDLE_KINDS];

/** A decoded Buffer, Window or Tabpage handle. */
export interface NvimHandle {
  readonly kind: NvimHandleKind;
  readonly id: number;
}

/** The extension type numbers Neovim assigns, in its own order. */
const EXTENSION_KINDS: ReadonlyArray<NvimHandleKind> = [
  NVIM_HANDLE_KINDS.buffer,
  NVIM_HANDLE_KINDS.window,
  NVIM_HANDLE_KINDS.tabpage,
];

export class NvimRpcError extends Data.TaggedError("NvimRpcError")<{
  readonly method: string;
  readonly message: string;
}> {}

export interface NvimNotification {
  readonly method: string;
  readonly params: ReadonlyArray<unknown>;
}

/**
 * The byte pipe the framing runs over.
 *
 * Taken as a parameter so the tests can drive it with no process attached: the
 * framing is the part that is worth testing on its own, and standing up a real
 * Neovim to check that a response matches its request tests Neovim.
 */
export interface NvimRpcDuplex {
  write(bytes: Uint8Array): void;
  readonly data: Stream.Stream<Uint8Array, unknown>;
}

export interface NvimRpc {
  readonly request: (
    method: string,
    params: ReadonlyArray<unknown>,
  ) => Effect.Effect<unknown, NvimRpcError>;
  readonly notify: (method: string, params: ReadonlyArray<unknown>) => Effect.Effect<void>;
  readonly notifications: Stream.Stream<NvimNotification>;
}

let extensionsRegistered = false;

/**
 * Teaches the decoder Neovim's handle types.
 *
 * Without this the decoder throws on the first `win_pos` event, which arrives
 * immediately after a UI attach — so the failure looks like the attach itself
 * being broken rather than like a missing codec.
 */
function registerExtensions(): void {
  // WORKAROUND: `addExtension` writes into a table that msgpackr keeps at module
  // scope, shared by every Packr and Unpackr in the process — its non-class
  // extension API has no per-instance registry, so there is nowhere else to put
  // this. Nothing collides today: Effect's own RPC and msgpack transports build
  // their own instances but register no extension types, and 0, 1 and 2 are
  // Neovim's. The risk is a future one, and it is silent — another registrant
  // for those numbers would make Buffer, Window and Tabpage handles decode as
  // whatever it returns, everywhere, with no error. Anything in this process
  // that registers a msgpack extension has to check this first. Remove once
  // msgpackr grows a per-instance extension table.
  if (extensionsRegistered) return;
  extensionsRegistered = true;
  for (const [index, kind] of EXTENSION_KINDS.entries()) {
    // `unpack`, not `read`: msgpackr stores whatever this key holds straight
    // into its extension table and calls it, so the wrong key registers an
    // object where a function is expected. The decoder then throws on the very
    // first handle Neovim sends, which is the answer to `nvim_get_current_buf`
    // — and because the throw aborts the whole read, the response is never
    // delivered and the call simply never returns.
    addExtension({
      type: index,
      unpack: (data: Uint8Array) => ({ kind, id: handleId(data) }) satisfies NvimHandle,
    });
  }
}

/**
 * A handle's payload is a msgpack integer, nested inside the extension body.
 *
 * Neovim packs the id rather than writing it raw, so a one-byte payload is a
 * fixint and a larger one carries its own width marker.
 */
function handleId(data: unknown): number {
  if (typeof data === "number") return data;
  if (!(data instanceof Uint8Array)) return Number(data);
  const decoded = unpackHandlePayload(data);
  return decoded;
}

function unpackHandlePayload(data: Uint8Array): number {
  const first = data[0] ?? 0;
  if (first <= 0x7f) return first;
  if (first === 0xcc) return data[1] ?? 0;
  if (first === 0xcd) return ((data[1] ?? 0) << 8) | (data[2] ?? 0);
  if (first === 0xce) {
    return ((data[1] ?? 0) << 24) | ((data[2] ?? 0) << 16) | ((data[3] ?? 0) << 8) | (data[4] ?? 0);
  }
  // Anything else is a width Neovim does not use for a handle; read the bytes
  // as a big-endian integer rather than guessing at a marker.
  let id = 0;
  for (const byte of data) id = id * 256 + byte;
  return id;
}

const packr = new Packr({ useRecords: false });

/** Encodes one frame for the writer. */
export function packNvimFrame(frame: ReadonlyArray<unknown>): Uint8Array {
  registerExtensions();
  return packr.pack(frame) as Uint8Array;
}

/**
 * Opens the framing over a duplex.
 *
 * Scoped: the reader runs for as long as the scope does, and every request
 * still in flight when it closes is failed rather than left hanging.
 */
export const makeNvimRpc = Effect.fn("NvimRpc.make")(function* (duplex: NvimRpcDuplex) {
  registerExtensions();

  const pending = new Map<number, Deferred.Deferred<unknown, NvimRpcError>>();
  // Typed with `Done` so the stream can be ended: a channel that cannot be read
  // any more should finish its consumers rather than leave them waiting.
  const notifications = yield* Queue.make<NvimNotification, Cause.Done>();
  let nextMessageId = 0;

  const unpackr = new Unpackr({ useRecords: false });
  // A socket splits wherever it likes, so an incomplete tail is kept and
  // prepended to the next read rather than thrown away.
  let tail: Uint8Array = EMPTY;

  const deliver = (frame: unknown) => {
    if (!Array.isArray(frame) || frame.length < 3) return;
    const [kind] = frame as [number, ...unknown[]];
    if (kind === 1) {
      const [, messageId, error, result] = frame as [number, number, unknown, unknown];
      const waiting = pending.get(messageId);
      if (waiting === undefined) return;
      pending.delete(messageId);
      Deferred.doneUnsafe(
        waiting,
        error === null || error === undefined
          ? Effect.succeed(result)
          : Effect.fail(new NvimRpcError({ method: `#${messageId}`, message: describe(error) })),
      );
      return;
    }
    if (kind === 2) {
      const [, method, params] = frame as [number, string, ReadonlyArray<unknown>];
      Queue.offerUnsafe(notifications, { method, params: params ?? [] });
    }
  };

  const consume = (chunk: Uint8Array): NvimRpcError | null => {
    const combined = tail.length === 0 ? chunk : concat(tail, chunk);
    const frames: unknown[] = [];
    let consumed = 0;
    let fatal: NvimRpcError | null = null;
    try {
      // `unpackMultiple` reports the end offset of each complete value as it
      // goes, and throws once it meets one it cannot read.
      unpackr.unpackMultiple(combined, (value: unknown, _start?: number, end?: number) => {
        frames.push(value);
        if (typeof end === "number") consumed = end;
      });
    } catch (error) {
      // Two very different things throw here and only one of them is routine.
      //
      // A truncated frame is a socket splitting where it likes: keep the tail
      // and the next read completes it. A frame that is malformed rather than
      // merely short never completes, so retrying it forever wedges the tail at
      // the same byte — no response or notification is ever delivered again,
      // the tail grows on every chunk, and nothing says why. msgpackr marks the
      // routine case with `incomplete`, so the other one is surfaced instead of
      // being waited on.
      const failure = error as { incomplete?: boolean; lastPosition?: number };
      if (typeof failure.lastPosition === "number") consumed = failure.lastPosition;
      if (failure.incomplete !== true) {
        fatal = new NvimRpcError({
          method: "<decode>",
          message: `unreadable frame at byte ${consumed}: ${String(error)}`,
        });
      }
    }
    tail = consumed >= combined.length ? EMPTY : combined.subarray(consumed);
    for (const frame of frames) deliver(frame);
    return fatal;
  };

  /** Set once the channel cannot answer again; later requests fail at once. */
  let closedWith: NvimRpcError | null = null;

  /** Fails every waiting request, for a channel that cannot recover. */
  const abort = (failure: NvimRpcError) => {
    closedWith ??= failure;
    for (const [, waiting] of pending) Deferred.doneUnsafe(waiting, Effect.fail(failure));
    pending.clear();
    Queue.endUnsafe(notifications);
  };

  yield* duplex.data.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        const fatal = consume(chunk);
        if (fatal === null) return;
        yield* Effect.logError("the Neovim channel sent a frame it cannot read", {
          message: fatal.message,
        });
        abort(fatal);
      }),
    ),
    // The output ending is the process ending. Without this, a request already
    // waiting when Neovim died waited forever, and every request after it was
    // written into a closed pipe and waited forever too — under the thread's
    // lock, so the whole editor for that thread stopped answering.
    Effect.andThen(() =>
      Effect.sync(() => abort(new NvimRpcError({ method: "<closed>", message: "Neovim exited" }))),
    ),
    // Interruption is how this fiber ends when the scope closes, and saying so
    // every time would be noise. Anything else is a defect worth seeing, and
    // closes the channel the same way an ended output does: a read that failed
    // leaves the requests waiting on it with nothing left to answer them.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("the Neovim read loop stopped", { cause }).pipe(
            Effect.andThen(
              Effect.sync(() =>
                abort(
                  new NvimRpcError({ method: "<closed>", message: "the Neovim channel failed" }),
                ),
              ),
            ),
          ),
    ),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closedWith ??= new NvimRpcError({ method: "<closed>", message: "the session closed" });
      for (const [, waiting] of pending) Deferred.doneUnsafe(waiting, Effect.fail(closedWith));
      pending.clear();
    }),
  );

  const request: NvimRpc["request"] = (method, params) =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<unknown, NvimRpcError>();
      // Checked with nothing that can yield between it and `pending.set`, so a
      // close cannot land in between and leave this request unanswered.
      if (closedWith !== null) return yield* closedWith;
      const messageId = nextMessageId;
      nextMessageId += 1;
      pending.set(messageId, deferred);
      duplex.write(packNvimFrame([0, messageId, method, params]));
      return yield* Deferred.await(deferred);
    });

  const notify: NvimRpc["notify"] = (method, params) =>
    Effect.sync(() => {
      duplex.write(packNvimFrame([2, method, params]));
    });

  return {
    request,
    notify,
    notifications: Stream.fromQueue(notifications),
  } satisfies NvimRpc;
});

const EMPTY = new Uint8Array(0);

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function describe(error: unknown): string {
  if (Array.isArray(error)) return String(error[1] ?? error[0] ?? "unknown");
  return String(error);
}
