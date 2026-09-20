import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type DaemonCommand, decodeDaemonCommand, replyLine } from "@symmetria/fm-core/command";
import { failure, isFailure, type Result, success } from "@symmetria/fm-core/contract";

/**
 * The socket that makes one daemon the daemon.
 *
 * A Unix socket rather than Electron's built-in second-instance mechanism, and
 * the research scored that choice rather than assuming it: delivering one
 * message through `second-instance` costs the sender a complete Electron cold
 * start, and it has no reply channel at all — the resident process physically
 * cannot answer a rejection, which is the one thing a portal request needs.
 */

/**
 * NOT `symmetria-fm.sock`.
 *
 * That path belongs to the Qt daemon, which the operator uses every day. The
 * two applications are meant to run side by side until the rewrite reaches
 * parity, so binding the same name would take their working file manager down
 * the first time this one started.
 */
const SOCKET_BASENAME = "symmetria-fm-electron.sock";

/** Where the daemon listens. The override exists so tests never touch the real one. */
export function daemonSocketPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.SYMMETRIA_FM_SOCKET;
  if (override !== undefined && override !== "") return override;

  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime !== "") return join(runtime, SOCKET_BASENAME);

  // A session without a runtime directory is unusual but not broken — a
  // container, a bare CI box. Refusing to start there would be worse than a
  // less private location, and the mode bits below still apply.
  return join(tmpdir(), SOCKET_BASENAME);
}

export type CommandHandler = (command: DaemonCommand) => Promise<Result<null>>;

export interface DaemonSocket {
  close(): Promise<void>;
}

/** How long a client may hold a connection open without sending a whole line. */
const READ_TIMEOUT_MS = 5_000;

/** A line longer than this is not a command anybody meant to send. */
const MAX_LINE_BYTES = 64 * 1024;

/**
 * Is somebody already listening here?
 *
 * **This is the check the Qt build does not do**, and its absence is a real
 * defect rather than a stylistic difference: `server.cpp` calls
 * `QLocalServer::removeServer` unconditionally before listening, with a comment
 * claiming that is safe "because a second instance is rejected after this point
 * by listen()". By that point the remove has already destroyed the live
 * daemon's socket, so the second instance does not lose the race — it wins one
 * it should never have been allowed to enter.
 */
function isSocketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    const settle = (live: boolean) => {
      probe.destroy();
      resolve(live);
    };
    probe.once("connect", () => settle(true));
    // ENOENT (no file) and ECONNREFUSED (a file with nothing behind it) are the
    // two shapes of "stale", and ONLY those two mean this process may take the
    // path.
    //
    // Anything else fails CLOSED. The first version treated every error as
    // "dead", which meant an EACCES or EPERM — a socket that is there and
    // reachable but not by us — would be unlinked and rebound over. That is the
    // same shape of defect this function exists to close in the Qt build, one
    // error code narrower. Review found it.
    probe.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code !== "ENOENT" && error.code !== "ECONNREFUSED");
    });
  });
}

async function readCommandLine(connection: Socket): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    const done = (line: string | null) => {
      connection.removeAllListeners("data");
      resolve(line);
    };

    connection.setEncoding("utf8");
    connection.setTimeout(READ_TIMEOUT_MS, () => done(null));
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      // Bounded before the newline search, not after. An unbounded accumulator
      // lets any local process grow this daemon's heap by never sending one.
      if (buffer.length > MAX_LINE_BYTES) return done(null);

      const end = buffer.indexOf("\n");
      if (end !== -1) done(buffer.slice(0, end));
    });
    connection.once("error", () => done(null));
    connection.once("end", () => done(buffer.length > 0 ? buffer : null));
  });
}

/**
 * Take the socket, or report that somebody else has it.
 *
 * The order matters and is the whole of this function: probe, then unlink only
 * what the probe proved dead, then listen, then narrow the permissions.
 */
export async function claimSocket(
  path: string,
  handler: CommandHandler,
): Promise<Result<DaemonSocket>> {
  if (await isSocketLive(path)) {
    return failure("conflict", `a daemon is already listening on ${path}`);
  }

  // Only reachable when the probe said nothing is behind it. A crash leaves the
  // file with no listener, and refusing to start then would need a human to
  // delete a file before the application would run again.
  await unlink(path).catch(() => undefined);

  // 0700 on the directory is the half that actually protects the socket: on
  // Linux the permission bits of a socket file are honoured for `connect`, but
  // a directory nobody else may traverse is the guarantee that does not depend
  // on that being true of every filesystem.
  //
  // **Only a directory this call created is chmodded**, and the guard is not
  // caution. `dirname(path)` is normally `$XDG_RUNTIME_DIR`, and with that
  // variable unset it is the shared temporary directory — so an unconditional
  // chmod would narrow `/tmp` to 0700 for every process on the machine the
  // first time this daemon started as root without a session. Review found it.
  // `mkdir` with `recursive` returns the first path it created and `undefined`
  // when there was nothing to create, which is exactly the distinction needed.
  const directory = dirname(path);
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined) await chmod(directory, 0o700).catch(() => undefined);

  const server = createServer((connection) => {
    void (async () => {
      const line = await readCommandLine(connection);
      if (line === null) return connection.end();

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Malformed JSON is answered rather than dropped. A caller that gets
        // nothing back cannot tell a rejection from a daemon that is not there.
        connection.end(replyLine(failure("invalid_request", "command must be one JSON line")));
        return;
      }

      const command = decodeDaemonCommand(parsed);
      if (isFailure(command)) return connection.end(replyLine(command));

      const result = await handler(command.value);
      connection.end(replyLine(result));
    })();
  });

  const listening = await new Promise<Result<Server>>((resolve) => {
    server.once("error", (error: Error) =>
      resolve(failure("write_failed", `could not listen on ${path}: ${error.message}`)),
    );
    server.listen(path, () => resolve(success(server)));
  });
  if (isFailure(listening)) return listening;

  await chmod(path, 0o600);

  return success({
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  });
}

/**
 * Send one command and read the one-line answer.
 *
 * Used by the tests and by any in-process caller. **The command-line tool does
 * not use it** and deliberately carries its own dozen lines instead: it must run
 * with no build step and no dependencies, which is the entire reason it exists
 * as a separate file rather than as a mode of this application. That constraint
 * is what makes the two genuinely different requirements rather than one
 * duplicated.
 */
/** What the daemon answers a command with: whether it worked, and why not. */
export interface CommandReply {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Read the daemon's one-line answer, or say why there is no answer.
 *
 * Checked rather than asserted. The peer is this application's own server, so
 * the shape is not in doubt in practice — but `JSON.parse` accepts `null`,
 * `123` and `"ok"` without throwing, and each of those would resolve a value
 * whose `.ok` the caller reads off nothing. A truncated line is exactly how
 * that arrives.
 */
function readReply(buffer: string): CommandReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.trim());
  } catch {
    return { ok: false, error: "no reply" };
  }
  // Narrowed with `in` rather than an assertion, so nothing here claims a
  // shape it has not just proven.
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "malformed reply" };
  }
  if (!("ok" in parsed) || typeof parsed.ok !== "boolean") {
    return { ok: false, error: "malformed reply" };
  }
  if ("error" in parsed && typeof parsed.error === "string") {
    return { ok: parsed.ok, error: parsed.error };
  }
  return { ok: parsed.ok };
}

export async function sendCommand(path: string, payload: unknown): Promise<CommandReply> {
  return new Promise((resolve) => {
    const connection = createConnection(path);
    let buffer = "";

    connection.setEncoding("utf8");
    connection.setTimeout(READ_TIMEOUT_MS, () => {
      connection.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    connection.once("connect", () => connection.write(`${JSON.stringify(payload)}\n`));
    connection.on("data", (chunk: string) => {
      buffer += chunk;
    });
    connection.once("error", (error: Error) => resolve({ ok: false, error: error.message }));
    connection.once("close", () => resolve(readReply(buffer)));
  });
}
