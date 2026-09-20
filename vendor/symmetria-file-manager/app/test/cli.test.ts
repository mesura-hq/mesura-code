import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimSocket } from "../src/main/socket.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/symmetria-fm-electron-cli.mjs", import.meta.url));

/**
 * Acceptance criterion 7 of phase 1.
 *
 * The command-line tool is plain Node and never Electron, and that is the point
 * of measuring it here: an Electron binary would pay a full cold start — a
 * quarter of a second at best — to deliver one line to a process that is already
 * running. Every system file dialog in the session would eventually pay it.
 *
 * The exit code is the contract, not a detail. The Qt build's portal backend
 * branches on it, and whatever replaces that backend will do the same.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fm-cli-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run the tool against a socket path, returning its code and streams. */
async function cli(
  args: readonly string[],
  socket: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const out = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, SYMMETRIA_FM_SOCKET: socket },
    });
    return { code: 0, stdout: out.stdout, stderr: out.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("the command-line tool", () => {
  it("delivers an open to a running daemon and exits 0", async () => {
    const socket = join(dir, "d.sock");
    const seen: string[] = [];
    const claim = await claimSocket(socket, async (command) => {
      if (command.cmd === "open") seen.push(command.path);
      return { ok: true, value: null };
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const out = await cli(["open", "/home/jc/Downloads"], socket);

    expect(out.code).toBe(0);
    expect(seen).toEqual(["/home/jc/Downloads"]);
    await claim.value.close();
  });

  it("exits 1 when the daemon rejects the command", async () => {
    const socket = join(dir, "d.sock");
    const claim = await claimSocket(socket, async () => ({
      ok: false,
      error: { code: "invalid_request", message: "no" },
    }));
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const out = await cli(["open", "relative/path"], socket);

    expect(out.code).toBe(1);
    await claim.value.close();
  });

  it("exits 1 when no daemon is listening, and says so", async () => {
    // The common case for a user: they ran it before anything started it. A
    // silent failure here reads as the file manager being broken.
    const out = await cli(["open", "/tmp"], join(dir, "nothing.sock"));

    expect(out.code).toBe(1);
    expect(`${out.stderr}${out.stdout}`.length).toBeGreaterThan(0);
  });

  it("exits 1 on an unknown subcommand rather than doing something else", async () => {
    const socket = join(dir, "d.sock");
    const claim = await claimSocket(socket, async () => ({ ok: true, value: null }));
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const out = await cli(["destroy", "/tmp"], socket);

    expect(out.code).toBe(1);
    await claim.value.close();
  });

  it("delivers a createPicker with its options and exits 0", async () => {
    // The portal backend's whole job is this one call, so the tool has to be
    // able to make it without a build step and without Electron.
    const socket = join(dir, "d.sock");
    const seen: unknown[] = [];
    const claim = await claimSocket(socket, async (command) => {
      seen.push(command);
      return { ok: true, value: null };
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const out = await cli(
      [
        "createPicker",
        JSON.stringify({
          fifo: "/tmp/symmetria-picker-abc.fifo",
          title: "Save your download",
          saveMode: true,
          suggestedName: "report.pdf",
        }),
      ],
      socket,
    );

    expect(out.code).toBe(0);
    expect(seen).toEqual([
      {
        cmd: "createPicker",
        fifo: "/tmp/symmetria-picker-abc.fifo",
        options: {
          title: "Save your download",
          acceptLabel: "",
          multiple: false,
          directory: false,
          saveMode: true,
          suggestedName: "report.pdf",
          currentFolder: "",
        },
      },
    ]);
    await claim.value.close();
  });

  it("delivers a closePicker and exits 0", async () => {
    const socket = join(dir, "d.sock");
    const seen: unknown[] = [];
    const claim = await claimSocket(socket, async (command) => {
      seen.push(command);
      return { ok: true, value: null };
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const out = await cli(
      ["closePicker", JSON.stringify({ fifo: "/tmp/symmetria-picker-abc.fifo" })],
      socket,
    );

    expect(out.code).toBe(0);
    expect(seen).toEqual([{ cmd: "closePicker", fifo: "/tmp/symmetria-picker-abc.fifo" }]);
    await claim.value.close();
  });

  it("exits 1 when a picker command's JSON argument is missing or malformed", async () => {
    // The portal builds this argument with `json.dumps`, so a malformed one
    // means the caller is broken — and reporting it as a usage error is what
    // stops the daemon being blamed for it.
    const socket = join(dir, "d.sock");
    const claim = await claimSocket(socket, async () => ({ ok: true, value: null }));
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    expect((await cli(["createPicker"], socket)).code).toBe(1);
    expect((await cli(["createPicker", "{not json"], socket)).code).toBe(1);
    expect((await cli(["closePicker"], socket)).code).toBe(1);
    await claim.value.close();
  });

  it("is not an Electron binary", async () => {
    // It runs under plain Node, which is the whole reason it is a separate
    // file rather than a mode of the application. Asserted by running it with
    // this test's own `process.execPath`, which is Node: an Electron entry
    // point would fail to start under it.
    const out = await cli(["--help"], join(dir, "unused.sock"));

    expect(out.stdout + out.stderr).toMatch(/open/);
  });
});
