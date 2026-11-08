// @effect-diagnostics nodeBuiltinImport:off - a second msgpack-RPC client on a Unix socket.
/**
 * A second channel into a manager's Neovim, for state the wire omits (`win_viewport` has no
 * `leftcol`). The adapter adds `--listen` on a test-owned socket, and the manager's own traffic
 * stays on `--embed` stdio. The side channel only asks; a probe that changes state says so.
 *
 * @module nvimSideChannel
 */
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Packr, unpackMultiple, UnpackrStream } from "msgpackr";

import { NvimAdapter } from "../NvimAdapter.ts";

// No msgpack extension is registered here. msgpackr keeps one extension table
// per process, and `NvimRpc.ts` owns types 0 to 2 in it (see the WORKAROUND
// there); the probes below return plain tables and numbers, never handles.

/**
 * The real adapter with `--listen <socketPath>` before the manager's arguments, because the launch
 * ends with `--` and a file name. `onRequest` hears the method of every request the manager writes
 * to Neovim, so a test can count the grid resizes it caused.
 */
export const listeningAdapterLayer = (socketPath: string, onRequest?: (method: string) => void) =>
  Layer.effect(
    NvimAdapter,
    Effect.gen(function* () {
      const real = yield* NvimAdapter;
      return NvimAdapter.of({
        spawn: Effect.fn("NvimAdapter.spawn")(function (input) {
          return real.spawn({ ...input, args: ["--listen", socketPath, ...input.args] }).pipe(
            Effect.map((process) =>
              onRequest === undefined
                ? process
                : {
                    ...process,
                    write: (bytes: Uint8Array) => {
                      try {
                        for (const message of unpackMultiple(bytes) as unknown[][]) {
                          if (message[0] === 0 && typeof message[2] === "string") {
                            onRequest(message[2]);
                          }
                        }
                      } catch {
                        /* a frame split across writes is not a request to count */
                      }
                      process.write(bytes);
                    },
                  },
            ),
          );
        }),
      });
    }),
  );

export interface SideChannel {
  readonly request: (method: string, params: ReadonlyArray<unknown>) => Effect.Effect<unknown>;
  /** Runs Lua inside the window showing the file whose name ends with `suffix`. */
  readonly inFileWindow: (suffix: string, lua: string) => Effect.Effect<unknown>;
  /** The window's view of the file: `winsaveview()` in that window. */
  readonly viewOf: (suffix: string) => Effect.Effect<FileWindowView>;
}

export interface FileWindowView {
  readonly leftcol: number;
  readonly topline: number;
  /** One-based. */
  readonly lnum: number;
  /** Zero-based byte column, as `winsaveview` reports it. */
  readonly col: number;
}

const IN_FILE_WINDOW_LUA = `local suffix, body = ...
for _, window in ipairs(vim.api.nvim_list_wins()) do
  local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(window))
  if name:sub(-#suffix) == suffix then
    return vim.api.nvim_win_call(window, assert(load(body)))
  end
end
error("no window shows a file named *" .. suffix)`;

/**
 * Connects to `socketPath` for the life of the scope. Neovim listens from its
 * first moment, so once the manager's `open` has returned the socket is there.
 */
export const connectSideChannel = Effect.fn(function* (socketPath: string) {
  const socket = yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Socket>((resume) => {
      const connection = NodeNet.createConnection(socketPath, () =>
        resume(Effect.succeed(connection)),
      );
      connection.once("error", (error) => resume(Effect.die(error)));
    }),
    (connection) => Effect.sync(() => connection.destroy()),
  );
  const packr = new Packr({ useRecords: false });
  const unpacker = new UnpackrStream({ useRecords: false, mapsAsObjects: true });
  socket.pipe(unpacker);
  const pending = new Map<number, (error: unknown, result: unknown) => void>();
  unpacker.on("data", (message: ReadonlyArray<unknown>) => {
    if (message[0] !== 1) return;
    const answer = pending.get(message[1] as number);
    pending.delete(message[1] as number);
    answer?.(message[2], message[3]);
  });
  let nextId = 0;

  const request = (method: string, params: ReadonlyArray<unknown>) =>
    Effect.callback<unknown>((resume) => {
      nextId += 1;
      pending.set(nextId, (error, result) =>
        resume(
          error === null || error === undefined
            ? Effect.succeed(result)
            : Effect.die(new Error(`${method}: ${JSON.stringify(error)}`)),
        ),
      );
      socket.write(packr.pack([0, nextId, method, params]));
    });

  const inFileWindow = (suffix: string, lua: string) =>
    request("nvim_exec_lua", [IN_FILE_WINDOW_LUA, [suffix, lua]]);

  const viewOf = (suffix: string) =>
    inFileWindow(suffix, "return vim.fn.winsaveview()") as Effect.Effect<FileWindowView>;

  return { request, inFileWindow, viewOf } satisfies SideChannel;
});
