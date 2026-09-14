import {
  type Decoder,
  decodePath,
  failure,
  isFailure,
  isRecord,
  type Result,
  success,
} from "./contract.ts";

/**
 * What a running daemon accepts over its socket, and what it answers.
 *
 * **This input is untrusted, and more sharply than the renderer's.** Any process
 * running as this user can connect to the socket and write to it, so a command
 * gets the same decoding an IPC payload gets — a value returned, never an
 * exception thrown, because a decoder that throws takes the connection down
 * instead of answering it.
 *
 * The path rules are `decodePath`'s and are deliberately not restated here. A
 * second copy would pass its own tests on the day it was written and drift
 * afterwards, and the looser of the two copies is the one an attacker uses.
 */

export interface OpenCommand {
  readonly cmd: "open";
  /** Absolute, NUL-free, within the kernel's length limit. */
  readonly path: string;
}

/**
 * Where a picker writes its answer.
 *
 * **The prefix is a security boundary, not a naming convention.** This path
 * arrives on a socket any process running as this user can write to, and the
 * daemon is about to OPEN IT FOR WRITING and put the user's chosen filenames
 * into it. Without the constraint, a caller could name any writable path.
 *
 * The same literal is `kValidFifoPrefix` in `host/standalone/server.cpp` and
 * `FIFO_PREFIX` in `portal/symmetria_portal.py`, which is what creates the
 * FIFO. All three must agree.
 */
export const PICKER_FIFO_PREFIX = "/tmp/symmetria-picker-";

/**
 * What a cancellation looks like on the wire.
 *
 * A protocol constant shared with the Qt build and the portal backend:
 * `_cancelledSentinel` in `host/standalone/main.qml` and `CANCELLED_SENTINEL` in
 * `portal/symmetria_portal.py`. A backend reading a different word would treat a
 * cancel as a chosen file literally named `__PICKER_CANCELLED__`.
 *
 * It lives here rather than beside the writer because it is part of the protocol
 * rather than part of the writing — and this package compiles against no
 * environment, so the decision layer can read it without dragging `node:fs` in.
 */
export const CANCELLED_SENTINEL = "__PICKER_CANCELLED__";

/**
 * The chosen paths, as the portal parses them.
 *
 * Newline-separated with no trailing newline, matching what the Qt daemon
 * writes. The reader strips and drops empty lines either way, but matching it
 * exactly means one backend can serve both applications unchanged.
 */
export function selectionPayload(paths: readonly string[]): string {
  return paths.join("\n");
}

/** What kind of dialog the portal asked for. Defaults are the Qt build's. */
export interface PickerOptions {
  readonly title: string;
  readonly acceptLabel: string;
  readonly multiple: boolean;
  readonly directory: boolean;
  readonly saveMode: boolean;
  readonly suggestedName: string;
  /** Where the dialog opens. Empty means the caller had no preference. */
  readonly currentFolder: string;
}

export interface CreatePickerCommand {
  readonly cmd: "createPicker";
  readonly fifo: string;
  readonly options: PickerOptions;
}

export interface ClosePickerCommand {
  readonly cmd: "closePicker";
  /**
   * Which picker to dismiss.
   *
   * Compared against the open picker's own FIFO before anything is closed. The
   * portal sends this when the CALLING application withdraws or dies, and by
   * then the picker it meant may already have been answered and replaced — so
   * honouring it blindly would close a dialog a different application is
   * waiting on.
   */
  readonly fifo: string;
}

export type DaemonCommand = OpenCommand | CreatePickerCommand | ClosePickerCommand;

/**
 * The FIFO rules, in one place because two copies would drift.
 *
 * `decodePath` first, so a picker path gets exactly the absolute/NUL-free/length
 * rules every other path gets. Then the prefix, then the parent segment.
 */
function decodeFifoPath(raw: unknown): Result<string> {
  const path = decodePath(raw);
  if (isFailure(path)) return path;

  if (!path.value.startsWith(PICKER_FIFO_PREFIX)) {
    return failure("invalid_request", `fifo must be inside ${PICKER_FIFO_PREFIX}`);
  }

  // `startsWith` alone accepts a path that begins with the prefix and then
  // climbs out of it, so what gets opened is not what was validated. Same shape
  // as the NUL byte `decodePath` rejects, one level up.
  if (path.value.split("/").includes("..")) {
    return failure("invalid_request", "fifo must not contain a parent segment");
  }

  return path;
}

function optionalString(raw: Record<string, unknown>, field: string, fallback: string) {
  const value = raw[field];
  if (value === undefined) return success(fallback);
  if (typeof value !== "string")
    return failure<string>("invalid_request", `${field} must be a string`);
  return success(value);
}

function optionalBoolean(raw: Record<string, unknown>, field: string, fallback: boolean) {
  const value = raw[field];
  if (value === undefined) return success(fallback);
  // Refused rather than coerced. `"false"` is truthy, and a dialog that opened
  // in multi-select because a caller sent a string is a bug nobody would find.
  if (typeof value !== "boolean") {
    return failure<boolean>("invalid_request", `${field} must be true or false`);
  }
  return success(value);
}

/**
 * The folder the dialog opens on.
 *
 * Empty is a real answer — the portal sends nothing when the calling
 * application had no preference — but a value that IS sent becomes a directory
 * this application navigates to, so it gets the full path rules rather than
 * being trusted because it is only a hint.
 */
function decodeCurrentFolder(raw: Record<string, unknown>): Result<string> {
  const value = raw.currentFolder;
  if (value === undefined || value === "") return success("");
  return decodePath(value);
}

function decodePickerOptions(raw: Record<string, unknown>): Result<PickerOptions> {
  // The defaults are `FileManagerService.qml`'s `startPickerMode`, so a portal
  // request that omits an option produces the same dialog from either build.
  const title = optionalString(raw, "title", "Select a File");
  if (isFailure(title)) return title;
  const acceptLabel = optionalString(raw, "acceptLabel", "");
  if (isFailure(acceptLabel)) return acceptLabel;
  const suggestedName = optionalString(raw, "suggestedName", "");
  if (isFailure(suggestedName)) return suggestedName;

  const multiple = optionalBoolean(raw, "multiple", false);
  if (isFailure(multiple)) return multiple;
  const directory = optionalBoolean(raw, "directory", false);
  if (isFailure(directory)) return directory;
  const saveMode = optionalBoolean(raw, "saveMode", false);
  if (isFailure(saveMode)) return saveMode;

  const currentFolder = decodeCurrentFolder(raw);
  if (isFailure(currentFolder)) return currentFolder;

  // `parentWindow` is deliberately absent, and its absence is a decision rather
  // than an omission: the portal sends a foreign-toplevel handle for
  // cross-application parenting, and Electron cannot import one. The Qt build
  // logs it and ignores it too. Accepting the field and dropping it keeps the
  // wire format identical between the two backends.
  return success({
    title: title.value,
    acceptLabel: acceptLabel.value,
    multiple: multiple.value,
    directory: directory.value,
    saveMode: saveMode.value,
    suggestedName: suggestedName.value,
    currentFolder: currentFolder.value,
  });
}

export const decodeDaemonCommand: Decoder<DaemonCommand> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "command must be an object");

  const cmd = raw.cmd;
  if (typeof cmd !== "string") return failure("invalid_request", "cmd must be a string");

  // Named rather than defaulted, and matched exactly rather than loosely. An
  // unrecognised command that fell through to one of these would run something
  // the caller did not ask for, and one that was silently ignored would report
  // success for work nobody did.
  if (cmd === "open") {
    const path = decodePath(raw.path);
    if (isFailure(path)) return path;
    return success({ cmd: "open", path: path.value });
  }

  if (cmd === "createPicker") {
    const fifo = decodeFifoPath(raw.fifo);
    if (isFailure(fifo)) return fifo;

    const options = decodePickerOptions(raw);
    if (isFailure(options)) return options;

    return success({ cmd: "createPicker", fifo: fifo.value, options: options.value });
  }

  if (cmd === "closePicker") {
    // The SAME rules the create applies. A close that validated more loosely
    // would be the looser half, and the two would drift apart silently.
    const fifo = decodeFifoPath(raw.fifo);
    if (isFailure(fifo)) return fifo;
    return success({ cmd: "closePicker", fifo: fifo.value });
  }

  return failure("invalid_request", `unknown command: ${cmd}`);
};

/**
 * The single line the daemon writes back, newline included.
 *
 * Newline-delimited because the caller reads until one: a reply split across
 * two reads has to be reassembled somehow, and a delimiter is the cheapest
 * agreement that makes that possible. The shape mirrors the Qt daemon's so the
 * two are legible side by side while both exist.
 */
export function replyLine(result: Result<unknown>): string {
  if (isFailure(result)) {
    return `${JSON.stringify({ ok: false, error: result.error.code, message: result.error.message })}\n`;
  }
  return `${JSON.stringify({ ok: true })}\n`;
}

/**
 * What the dialog's own page says the user did.
 *
 * Decoded rather than trusted, for the same reason every other payload is: the
 * renderer is sandboxed, but a boundary is a boundary and a malformed message
 * must not reach the FIFO writer. The FIFO gets the full picker-path rules —
 * one decoder, not a second looser copy — and every chosen path gets
 * `decodePath`'s.
 *
 * Naming the FIFO is not authority to answer it: `PickerHost.answer` refuses a
 * pipe that is not the open one, so a page cannot answer another dialog.
 */
export interface PickerAnswer {
  readonly fifo: string;
  readonly paths: readonly string[];
}

export const decodePickerAnswer: Decoder<PickerAnswer> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "answer must be an object");

  const fifo = decodeFifoPath(raw.fifo);
  if (isFailure(fifo)) return fifo;

  const paths = raw.paths;
  if (!Array.isArray(paths)) return failure("invalid_request", "paths must be a list");

  const decoded: string[] = [];
  for (const each of paths) {
    const path = decodePath(each);
    if (isFailure(path)) return path;
    decoded.push(path.value);
  }

  return success({ fifo: fifo.value, paths: decoded });
};

export interface PickerDismissal {
  readonly fifo: string;
}

export const decodePickerDismissal: Decoder<PickerDismissal> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "dismissal must be an object");
  const fifo = decodeFifoPath(raw.fifo);
  if (isFailure(fifo)) return fifo;
  return success({ fifo: fifo.value });
};
