import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimSocket, daemonSocketPath, sendCommand } from "../src/main/socket.ts";

/**
 * Who owns the socket, and what happens to the one who does not.
 *
 * Acceptance criteria 3 and 4 of phase 1.
 *
 * **Every test here works inside a temporary directory.** The real
 * `$XDG_RUNTIME_DIR` holds the Qt daemon's live socket, which the operator uses
 * daily; a test that wrote there could take their working file manager down.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fm-socket-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const accepted = async () => ({ ok: true as const, value: null });

describe("daemonSocketPath", () => {
  it("sits under the runtime directory when there is one", () => {
    const path = daemonSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(path.startsWith("/run/user/1000/")).toBe(true);
  });

  it("is NOT the Qt build's socket", () => {
    // The Qt daemon owns `symmetria-fm.sock` and the operator uses it every
    // day. Binding the same path would take their working file manager down,
    // and the two applications are meant to run side by side until parity.
    const path = daemonSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(path).not.toBe("/run/user/1000/symmetria-fm.sock");
  });

  it("falls back somewhere writable when the runtime directory is unset", () => {
    const path = daemonSocketPath({});
    expect(path.length).toBeGreaterThan(0);
    expect(path.startsWith("/")).toBe(true);
  });
});

describe("claiming the socket", () => {
  it("listens, and the socket is not readable by anybody else", async () => {
    const path = join(dir, "d.sock");

    const claim = await claimSocket(path, accepted);

    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    // 0600: the socket accepts commands, so another user reaching it would be
    // able to drive this daemon.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await claim.value.close();
  });

  it("refuses to take a socket a live daemon is behind", async () => {
    // The Qt build gets this wrong: `server.cpp` unlinks unconditionally
    // before listening, so a second daemon started by accident silently steals
    // the socket from a running one.
    const path = join(dir, "d.sock");
    const first = await claimSocket(path, accepted);
    expect(first.ok).toBe(true);

    const second = await claimSocket(path, accepted);

    expect(second.ok).toBe(false);
    if (first.ok) await first.value.close();
  });

  it("replaces a socket file left behind by a dead daemon", async () => {
    // A crash leaves the file with nothing listening. Refusing to start then
    // would need a human to delete a file before the application would run.
    const path = join(dir, "d.sock");
    await writeFile(path, "");

    const claim = await claimSocket(path, accepted);

    expect(claim.ok).toBe(true);
    if (claim.ok) await claim.value.close();
  });
});

describe("what it refuses to touch", () => {
  it("leaves the permissions of a directory it did not create alone", async () => {
    // Review found an unconditional `chmod(dirname(path), 0o700)`. The socket
    // sits directly in the runtime directory — or, with XDG_RUNTIME_DIR unset,
    // in the SHARED temporary directory — so on a machine where that call
    // succeeded it would narrow `/tmp` to 0700 for every process on the box.
    //
    // The rule is now: chmod only what this call created. This is the test that
    // says so, using a pre-existing directory with deliberately open bits.
    const open = join(dir, "already-here");
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    const path = join(open, "d.sock");

    const claim = await claimSocket(path, accepted);

    expect(claim.ok).toBe(true);
    expect((await stat(open)).mode & 0o777).toBe(0o755);
    if (claim.ok) await claim.value.close();
  });

  it("refuses a socket it cannot reach, rather than replacing it", async () => {
    // The other half of the same guarantee. `isSocketLive` used to read EVERY
    // connect error as "nothing is there", so an EACCES — a socket that exists
    // and is reachable, just not by us — would be unlinked and rebound over.
    // That is the same defect this module criticises in the Qt build, one error
    // code narrower.
    const sealed = join(dir, "sealed");
    await mkdir(sealed, { mode: 0o700 });
    const path = join(sealed, "d.sock");
    const live = await claimSocket(path, accepted);
    expect(live.ok).toBe(true);
    // Deny traversal, so a connect gets EACCES rather than ECONNREFUSED.
    await chmod(sealed, 0o000);

    const second = await claimSocket(path, accepted);

    // Restore before asserting, so a failure does not leave an unreadable
    // directory behind for the afterEach cleanup.
    await chmod(sealed, 0o700);

    // The CODE, not merely the failure. This assertion was written first as
    // `expect(second.ok).toBe(false)` and it passed with the defect
    // reintroduced — because a claim that wrongly decides the socket is dead
    // still fails, one step later, when `listen` hits the same EACCES. Same
    // outcome, opposite reasoning, and the weaker assertion could not tell
    // them apart. `conflict` is only reachable from the live-socket branch.
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
    if (live.ok) await live.value.close();
  });
});

describe("carrying a command", () => {
  it("delivers an open to the handler and answers ok", async () => {
    const path = join(dir, "d.sock");
    const seen: string[] = [];
    const claim = await claimSocket(path, async (command) => {
      // Narrowed rather than assumed. The command is a union of three verbs
      // now, and only one of them carries a path.
      if (command.cmd === "open") seen.push(command.path);
      return { ok: true, value: null };
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const reply = await sendCommand(path, { cmd: "open", path: "/home/jc/Downloads" });

    expect(seen).toEqual(["/home/jc/Downloads"]);
    expect(reply.ok).toBe(true);
    await claim.value.close();
  });

  it("answers a malformed line with a failure instead of dropping it", async () => {
    const path = join(dir, "d.sock");
    const claim = await claimSocket(path, accepted);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const reply = await sendCommand(path, { cmd: "definitely-not-a-command" });

    expect(reply.ok).toBe(false);
    await claim.value.close();
  });
});

/**
 * A peer that answers with whatever it is told to, so the reply reader can be
 * driven past the shapes this application's own server produces.
 *
 * Raw `net` rather than `claimSocket`, precisely because `claimSocket` is what
 * guarantees the well-formed shape — a test that went through it could only
 * ever exercise the happy path.
 */
async function peerAnswering(path: string, line: string): Promise<Server> {
  const server = createServer((connection) => {
    connection.on("data", () => {
      connection.write(`${line}\n`);
      connection.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return server;
}

describe("reading the daemon's answer", () => {
  // `JSON.parse` accepts `null`, `123` and `"ok"` without throwing, so a reply
  // that parsed was once handed straight back — and a caller reading `.ok` off
  // `null` throws a TypeError far from the cause. A truncated line is exactly
  // how that arrives.
  it.each([
    ["null", "a bare null"],
    ["123", "a number"],
    ['"ok"', "a string"],
    ["{}", "an object with no verdict"],
    ['{"ok":"yes"}', "a verdict that is not a boolean"],
  ])("calls %s malformed rather than passing it on (%s)", async (line) => {
    const path = join(dir, "peer.sock");
    const server = await peerAnswering(path, line);

    const reply = await sendCommand(path, { cmd: "open", path: "/tmp" });

    expect(reply).toEqual({ ok: false, error: "malformed reply" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Paired with the cases above, so a reader that called everything malformed
  // could not pass this file.
  it("passes a well-formed answer through, error and all", async () => {
    const path = join(dir, "peer.sock");
    const server = await peerAnswering(path, '{"ok":false,"error":"no such path"}');

    const reply = await sendCommand(path, { cmd: "open", path: "/tmp" });

    expect(reply).toEqual({ ok: false, error: "no such path" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
