import { describe, expect, it } from "vitest";
import { decodeDaemonCommand, replyLine } from "../src/command.ts";
import { isFailure } from "../src/contract.ts";

/**
 * The commands a running daemon accepts over its socket.
 *
 * Acceptance criteria 7 and 8 of phase 1.
 *
 * This input is untrusted in the same way the renderer's is, and for a sharper
 * reason: anything running as this user can connect to the socket and write to
 * it. So it gets the same treatment `decodeListRequest` gives an IPC payload —
 * a decoder that returns a value and never throws, with the same path rules.
 * A second decoder that forgot one of those rules would be a hole with the
 * first decoder's tests still passing beside it.
 */
describe("decodeDaemonCommand", () => {
  it("accepts an open with an absolute path", () => {
    const out = decodeDaemonCommand({ cmd: "open", path: "/home/jc/Downloads" });

    expect(isFailure(out)).toBe(false);
    if (isFailure(out)) return;
    expect(out.value.cmd).toBe("open");
    // Narrowed rather than asserted. The command is a union now, and a caller
    // that reaches for `path` without asking which arm it has is exactly the
    // mistake the union exists to make impossible.
    if (out.value.cmd !== "open") return;
    expect(out.value.path).toBe("/home/jc/Downloads");
  });

  it("refuses a relative path", () => {
    // The daemon has no working directory the caller could mean, so a relative
    // path can only be a mistake or an attempt to reach somewhere unintended.
    expect(isFailure(decodeDaemonCommand({ cmd: "open", path: "../etc" }))).toBe(true);
    expect(isFailure(decodeDaemonCommand({ cmd: "open", path: "Downloads" }))).toBe(true);
  });

  it("refuses a path longer than any the kernel could use", () => {
    const out = decodeDaemonCommand({ cmd: "open", path: `/${"a".repeat(5000)}` });
    expect(isFailure(out)).toBe(true);
  });

  it("refuses a path carrying a NUL byte", () => {
    // A NUL terminates the path at the syscall, so the path that gets opened is
    // not the path that was validated.
    expect(isFailure(decodeDaemonCommand({ cmd: "open", path: "/tmp/a\0/../etc" }))).toBe(true);
  });

  it("refuses an unknown command rather than ignoring it", () => {
    expect(isFailure(decodeDaemonCommand({ cmd: "rm", path: "/tmp" }))).toBe(true);
  });

  it("refuses a verb that only resembles a known one", () => {
    // Named rather than matched loosely. A decoder that lower-cased or trimmed
    // would accept a command the sender did not mean to send.
    for (const cmd of ["createpicker", "CreatePicker", " createPicker", "createPicker2"]) {
      expect(isFailure(decodeDaemonCommand({ cmd, fifo: VALID_FIFO })), cmd).toBe(true);
    }
  });
});

/**
 * The FIFO path a picker answers on.
 *
 * The Qt daemon validates this server-side before it trusts it —
 * `host/standalone/server.cpp` refuses a create or a close whose path is
 * outside `/tmp/symmetria-picker-`. The same rule applies here and for the same
 * reason: the path arrives from a socket any process running as this user can
 * write to, and the daemon is about to OPEN it for writing. Without the prefix,
 * a caller could name any writable path and have the file manager write the
 * user's chosen filenames into it.
 */
const VALID_FIFO = "/tmp/symmetria-picker-9f3a2b.fifo";

describe("createPicker", () => {
  it("accepts a request whose fifo is inside the picker prefix", () => {
    const out = decodeDaemonCommand({ cmd: "createPicker", fifo: VALID_FIFO });

    expect(isFailure(out)).toBe(false);
    if (isFailure(out)) return;
    expect(out.value.cmd).toBe("createPicker");
    if (out.value.cmd !== "createPicker") return;
    expect(out.value.fifo).toBe(VALID_FIFO);
  });

  it("refuses a fifo outside the picker prefix", () => {
    for (const fifo of ["/tmp/other.fifo", "/home/jc/.ssh/authorized_keys", "/tmp/symmetria-"]) {
      expect(isFailure(decodeDaemonCommand({ cmd: "createPicker", fifo })), fifo).toBe(true);
    }
  });

  it("refuses a fifo that climbs out of the prefix with a parent segment", () => {
    // `startsWith` alone accepts this: the string begins with the prefix and
    // then leaves it. What gets opened is not what was validated — the same
    // shape of defect as the NUL byte above, one level up.
    const escaping = "/tmp/symmetria-picker-x/../../home/jc/.bashrc";

    expect(isFailure(decodeDaemonCommand({ cmd: "createPicker", fifo: escaping }))).toBe(true);
  });

  it("refuses a fifo that is relative, empty or carries a NUL", () => {
    for (const fifo of ["", "tmp/symmetria-picker-x", "/tmp/symmetria-picker-a\0b"]) {
      expect(isFailure(decodeDaemonCommand({ cmd: "createPicker", fifo })), fifo).toBe(true);
    }
  });

  it("takes the Qt defaults for every option the caller leaves out", () => {
    // The defaults are `FileManagerService.qml`'s, so a portal request that
    // omits an option gets the same dialog from either build.
    const out = decodeDaemonCommand({ cmd: "createPicker", fifo: VALID_FIFO });

    expect(isFailure(out)).toBe(false);
    if (isFailure(out) || out.value.cmd !== "createPicker") return;
    expect(out.value.options).toEqual({
      title: "Select a File",
      acceptLabel: "",
      multiple: false,
      directory: false,
      saveMode: false,
      suggestedName: "",
      currentFolder: "",
    });
  });

  it("carries every option the caller does send", () => {
    const out = decodeDaemonCommand({
      cmd: "createPicker",
      fifo: VALID_FIFO,
      title: "Save your download",
      acceptLabel: "Save",
      multiple: true,
      directory: false,
      saveMode: true,
      suggestedName: "report.pdf",
      currentFolder: "/home/jc/Downloads",
      // Accepted and ignored: Electron cannot import a foreign Wayland
      // toplevel, so cross-application parenting is not available. The Qt build
      // logs it and ignores it too.
      parentWindow: "wayland:abc123",
    });

    expect(isFailure(out)).toBe(false);
    if (isFailure(out) || out.value.cmd !== "createPicker") return;
    expect(out.value.options).toEqual({
      title: "Save your download",
      acceptLabel: "Save",
      multiple: true,
      directory: false,
      saveMode: true,
      suggestedName: "report.pdf",
      currentFolder: "/home/jc/Downloads",
    });
  });

  it("refuses a currentFolder that is not an absolute path", () => {
    // It becomes the directory the window opens on, so it gets the same rules
    // every other path gets rather than being trusted because it is a hint.
    const out = decodeDaemonCommand({
      cmd: "createPicker",
      fifo: VALID_FIFO,
      currentFolder: "Downloads",
    });

    expect(isFailure(out)).toBe(true);
  });

  it("refuses an option whose type is wrong rather than coercing it", () => {
    const out = decodeDaemonCommand({ cmd: "createPicker", fifo: VALID_FIFO, multiple: "yes" });

    expect(isFailure(out)).toBe(true);
  });
});

describe("closePicker", () => {
  it("accepts a fifo inside the picker prefix", () => {
    const out = decodeDaemonCommand({ cmd: "closePicker", fifo: VALID_FIFO });

    expect(isFailure(out)).toBe(false);
    if (isFailure(out)) return;
    expect(out.value.cmd).toBe("closePicker");
    if (out.value.cmd !== "closePicker") return;
    expect(out.value.fifo).toBe(VALID_FIFO);
  });

  it("applies the same fifo rules the create applies", () => {
    // One rule, not two. A close that validated more loosely than the create
    // would be the looser half an attacker uses, and the two would drift.
    for (const fifo of ["/tmp/other.fifo", "", "/tmp/symmetria-picker-x/../etc"]) {
      expect(isFailure(decodeDaemonCommand({ cmd: "closePicker", fifo })), fifo).toBe(true);
    }
  });

  it("returns a failure rather than throwing, for every picker rejection", () => {
    for (const raw of [
      { cmd: "createPicker" },
      { cmd: "createPicker", fifo: 7 },
      { cmd: "closePicker" },
      { cmd: "closePicker", fifo: null },
    ]) {
      expect(() => decodeDaemonCommand(raw)).not.toThrow();
    }
  });

  it("refuses anything that is not an object", () => {
    expect(isFailure(decodeDaemonCommand(null))).toBe(true);
    expect(isFailure(decodeDaemonCommand("open /tmp"))).toBe(true);
    expect(isFailure(decodeDaemonCommand([]))).toBe(true);
  });

  it("returns a failure rather than throwing, for every rejection above", () => {
    // The socket handler must be able to answer every input. A decoder that
    // throws on one shape takes the connection down instead of replying.
    for (const raw of [null, "x", [], {}, { cmd: "open" }, { cmd: "open", path: 7 }]) {
      expect(() => decodeDaemonCommand(raw)).not.toThrow();
    }
  });
});

describe("replyLine", () => {
  it("is one line, and parses as the envelope", () => {
    const line = replyLine({ ok: true, value: null });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ ok: true });
  });

  it("carries the failure code and message on a rejection", () => {
    const line = replyLine({ ok: false, error: { code: "invalid_request", message: "nope" } });

    expect(JSON.parse(line)).toEqual({ ok: false, error: "invalid_request", message: "nope" });
  });
});
