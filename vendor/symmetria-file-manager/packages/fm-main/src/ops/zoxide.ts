import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type FrecentDirectory, parseFrecent } from "@symmetria/fm-core/zoxide";

const run = promisify(execFile);

/**
 * Ask zoxide which directories this user actually goes to.
 *
 * ── No shell, and a fixed argument list ─────────────────────────────────────
 * `execFile` and not `exec`. The difference is that `exec` hands the string to
 * `/bin/sh`, and every character a shell treats specially would then be one —
 * which matters here more than it looks, because zoxide's database is full of
 * directory names the operator did not choose. A path holding a quote, a `$` or
 * a `;` is an ordinary thing to have on a disk and must never become something
 * to execute. There is no interpolation into this command at all: the argument
 * list is a constant.
 */
const COMMAND = "zoxide";
const ARGUMENTS = ["query", "--list", "--score"] as const;

/**
 * How long to wait before giving up.
 *
 * The list is read from a local database and answers in milliseconds. A bound
 * exists because this blocks a popup the user is looking at: a hung subprocess
 * with no timeout is a window that never fills in and never says why.
 */
const TIMEOUT_MS = 3_000;

/** How much output to accept, so a pathological database cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type FrecentResult =
  | { readonly ok: true; readonly entries: readonly FrecentDirectory[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Read the frecent list, or say why it could not be read.
 *
 * Three outcomes, all values. The distinction that matters to a user is
 * "zoxide is not installed" against "zoxide has nothing recorded": the first is
 * something they can fix in one command and the second is simply how a fresh
 * database looks, and an empty popup cannot tell them apart.
 */
export async function frecentDirectories(): Promise<FrecentResult> {
  try {
    const { stdout } = await run(COMMAND, [...ARGUMENTS], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      // No shell, stated rather than left to the default, because the default
      // is the thing this must never do.
      shell: false,
    });
    return { ok: true, entries: parseFrecent(stdout) };
  } catch (cause) {
    return { ok: false, reason: explain(cause) };
  }
}

/** Turn a spawn failure into something worth putting on screen. */
function explain(cause: unknown): string {
  // SAFETY: asserts only that the value MIGHT carry these keys — every field is
  // optional, the type admits null, and the read is optionally chained — so a
  // cause of any shape at all reads as `undefined` and falls through to the
  // generic message below. Nothing here is trusted; the assertion buys the
  // property read, not a contract.
  const code = (cause as { code?: unknown } | null)?.code;

  // The one a user can act on, and the one an empty list is otherwise
  // indistinguishable from.
  if (code === "ENOENT") return "zoxide is not installed";

  // A timeout does NOT arrive as `ETIMEDOUT`, which is what this checked first
  // and is why the branch never once fired. Node kills the process and reports
  // the kill: `killed: true` with `signal: "SIGTERM"` and a null code. Without
  // this the user got Node's raw "Command failed: zoxide query --list --score",
  // which does not say that the actual problem was a hang.
  // SAFETY: same optional-and-chained read as `code` above.
  if ((cause as { killed?: boolean } | null)?.killed === true) return "zoxide did not answer";

  // The output cap. Its own code, and worth naming for the same reason as the
  // other two: the generic message is Node internals rather than something to
  // act on.
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "zoxide's answer was too large to read";
  }

  return cause instanceof Error ? cause.message : String(cause);
}
