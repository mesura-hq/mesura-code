import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

import { failure, type Result, success } from "@symmetria/fm-core/contract";

/**
 * Answering a caller that is blocked on a named pipe.
 *
 * **The whole point of this file is that something always arrives.** A picker
 * exists because an application asked the desktop for a file and is now blocked
 * reading a FIFO. Every way out of the dialog has to end here; a path that
 * returns without writing leaves that application frozen until the portal's
 * five-minute timeout, and the user with no idea why.
 *
 * It lives in the standalone host rather than in `packages/fm-main`. It would
 * pass the host-blindness test either way — it names no window and no
 * application object — but answering a desktop portal is a property of this
 * daemon, and the editor that will embed the panel does not answer file dialogs.
 */

export interface FifoWriteOptions {
  /** How long to keep trying in total. */
  readonly timeoutMs?: number;
  /** How long to wait between attempts while nothing is reading. */
  readonly retryMs?: number;
}

/**
 * Long enough for a reader that is starting up, far short of the portal's own
 * five minutes. A picker that cannot deliver its answer in ten seconds is
 * answering nobody, and holding the dialog open longer helps no one.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 25;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opened, or the reason it was not. Narrower than `Result` because "no reader yet" is not a failure. */
type OpenOutcome =
  | { readonly kind: "opened"; readonly handle: FileHandle }
  | { readonly kind: "no-reader" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Open the pipe for writing, without trusting what is at the path.
 *
 * Three flags, each load-bearing:
 *
 * - **`O_NONBLOCK`** is why this function can fail instead of hanging. A
 *   write-only open of a FIFO with no reader BLOCKS; `fs.promises.open` runs on
 *   libuv's threadpool, which has four threads by default, so four unanswered
 *   pickers would starve every other filesystem operation in the process. With
 *   the flag the kernel answers `ENXIO` at once and waiting becomes our choice.
 * - **`O_NOFOLLOW`** refuses a symlink standing where the FIFO should be.
 * - the **`isFIFO` check after the open** refuses a regular file.
 *
 * The last two are not paranoia. `/tmp` is world-writable, and ANY process
 * running as this user can send a `createPicker` naming any path under the
 * picker prefix — so without them, one could have the file manager write the
 * user's chosen filenames into a file of its choosing. The portal defends its
 * READ side exactly this way, with an `fstat` after the open; this is the
 * mirror of it, and the Qt build does not have it.
 *
 * The check is after the open rather than before it because a check before it
 * is a race: the path could be replaced in between. The descriptor is the only
 * thing worth asking about.
 */
async function openFifoForWriting(path: string): Promise<OpenOutcome> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (cause) {
    // SAFETY: `open` rejects only with an `ErrnoException`, and `code` is
    // declared optional on it, so a rejection from anywhere else still reads as
    // `undefined` rather than throwing.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENXIO") return { kind: "no-reader" };
    return { kind: "refused", reason: `${path}: ${code ?? String(cause)}` };
  }

  try {
    const stats = await handle.stat();
    if (stats.isFIFO()) return { kind: "opened", handle };
    await handle.close();
    return { kind: "refused", reason: `${path} is not a FIFO` };
  } catch (cause) {
    await handle.close().catch(() => undefined);
    return { kind: "refused", reason: `${path}: ${String(cause)}` };
  }
}

/**
 * Write every byte, or say why not.
 *
 * A loop rather than one call, because the descriptor is non-blocking: a write
 * larger than the pipe's buffer returns short, and one to a full pipe raises
 * `EAGAIN` rather than waiting. Payloads here are a few paths and will not reach
 * either case in practice — which is exactly why the code has to handle them,
 * since nothing in testing would.
 */
async function writeAll(
  handle: FileHandle,
  payload: string,
  deadline: number,
  retryMs: number,
): Promise<Result<null>> {
  const bytes = Buffer.from(payload, "utf8");
  let written = 0;

  while (written < bytes.length) {
    try {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
      written += bytesWritten;
    } catch (cause) {
      // SAFETY: as in `openFifoForWriting` above — `handle.write` rejects with
      // an `ErrnoException`, and `code` is optional on it.
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN") return failure("write_failed", `could not write: ${String(cause)}`);
      if (Date.now() >= deadline) return failure("write_failed", "the reader stopped reading");
      await delay(retryMs);
    }
  }

  return success(null);
}

/**
 * Put one payload on one pipe, retrying while nobody is reading.
 *
 * The real sequence has the reader there first — the portal blocks on the FIFO
 * before it ever sends the command — so the retry loop normally runs once. It
 * exists for the case where the command overtakes the reader, and it is bounded
 * so a pipe nobody ever reads costs a known amount of time rather than a thread.
 */
export async function writeToFifo(
  path: string,
  payload: string,
  options: FifoWriteOptions = {},
): Promise<Result<null>> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;

  for (;;) {
    const opened = await openFifoForWriting(path);

    if (opened.kind === "refused") return failure("write_failed", opened.reason);

    if (opened.kind === "opened") {
      try {
        return await writeAll(opened.handle, payload, deadline, retryMs);
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    }

    if (Date.now() >= deadline) {
      return failure("write_failed", `nothing is reading ${path}`);
    }
    await delay(retryMs);
  }
}
