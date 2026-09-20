import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The Symmetria file manager's bridge, carried over the WebSocket.
 *
 * The file manager's UI reaches its host through one object of channels
 * (`@symmetria/fm-core/bridge`), and both ends already decode every payload
 * with `@symmetria/fm-core/contract`. This contract types what that decoding
 * cannot: the envelope, the session, and the channel names — split by scope,
 * so a read token can never reach a write channel.
 *
 * The literals are a COPY of `@symmetria/fm-main/ipc/channels`, kept here so
 * mobile never depends on the vendored package. `apps/server` guards the copy
 * against the vendored table in a test.
 */

export const FILE_MANAGER_READ_CHANNELS = [
  "symmetria-fm:overview",
  "symmetria-fm:list",
  "symmetria-fm:watch",
  "symmetria-fm:unwatch",
  "symmetria-fm:read-text",
  "symmetria-fm:cancel",
  "symmetria-fm:describe",
  "symmetria-fm:preview-url",
  "symmetria-fm:preview-directory-url",
  "symmetria-fm:frecent",
  "symmetria-fm:search-start",
  "symmetria-fm:search-query",
  "symmetria-fm:search-record",
  "symmetria-fm:search-release",
  "symmetria-fm:bookmarks-read",
  "symmetria-fm:listing-read",
  "symmetria-fm:hide-window",
  "symmetria-fm:picker-confirm",
  "symmetria-fm:picker-cancel",
] as const;

export const FILE_MANAGER_WRITE_CHANNELS = [
  "symmetria-fm:transfer",
  "symmetria-fm:cancel-transfer",
  "symmetria-fm:create",
  "symmetria-fm:rename",
  "symmetria-fm:trash",
  "symmetria-fm:clipboard",
  "symmetria-fm:open",
  "symmetria-fm:bookmarks-write",
  "symmetria-fm:listing-write",
] as const;

export const FILE_MANAGER_PUSH_CHANNELS = [
  "symmetria-fm:list-batch",
  "symmetria-fm:changed",
  "symmetria-fm:transfer-progress",
  "symmetria-fm:open-path",
] as const;

export const FileManagerReadChannel = Schema.Literals(FILE_MANAGER_READ_CHANNELS);
export type FileManagerReadChannel = typeof FileManagerReadChannel.Type;

export const FileManagerWriteChannel = Schema.Literals(FILE_MANAGER_WRITE_CHANNELS);
export type FileManagerWriteChannel = typeof FileManagerWriteChannel.Type;

export const FileManagerPushChannel = Schema.Literals(FILE_MANAGER_PUSH_CHANNELS);
export type FileManagerPushChannel = typeof FileManagerPushChannel.Type;

/** Chosen by the client, one per mounted file manager; the event stream opens it. */
export const FileManagerSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type FileManagerSessionId = typeof FileManagerSessionId.Type;

export const FileManagerQueryInput = Schema.Struct({
  sessionId: FileManagerSessionId,
  channel: FileManagerReadChannel,
  payload: Schema.Unknown,
});
export type FileManagerQueryInput = typeof FileManagerQueryInput.Type;

export const FileManagerMutateInput = Schema.Struct({
  sessionId: FileManagerSessionId,
  channel: FileManagerWriteChannel,
  payload: Schema.Unknown,
});
export type FileManagerMutateInput = typeof FileManagerMutateInput.Type;

/** `FailureCode` in `@symmetria/fm-core/contract`, copied like the channels are. */
export const FILE_MANAGER_FAILURE_CODES = [
  "invalid_request",
  "scan_failed",
  "read_failed",
  "watch_failed",
  "cancelled",
  "conflict",
  "write_failed",
  "invalid_reply",
] as const;

export const FileManagerFailureCode = Schema.Literals(FILE_MANAGER_FAILURE_CODES);
export type FileManagerFailureCode = typeof FileManagerFailureCode.Type;

/** The shape of `IpcReply` in `@symmetria/fm-core/contract`: an outcome, never a throw. */
export const FileManagerReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: FileManagerFailureCode, message: Schema.String }),
  }),
]);
export type FileManagerReply = typeof FileManagerReply.Type;

export const FileManagerEventsInput = Schema.Struct({
  sessionId: FileManagerSessionId,
});
export type FileManagerEventsInput = typeof FileManagerEventsInput.Type;

export const FileManagerEvent = Schema.Struct({
  channel: FileManagerPushChannel,
  payload: Schema.Unknown,
});
export type FileManagerEvent = typeof FileManagerEvent.Type;

/**
 * The first item of every session's stream: the session exists on the server
 * from this point on. The stream is what opens a session, and a query that
 * arrives before it is refused as `session not open`, so a client waits for
 * this marker before its first call.
 */
export const FileManagerSessionReady = Schema.Struct({ ready: Schema.Literal(true) });
export type FileManagerSessionReady = typeof FileManagerSessionReady.Type;

export const FileManagerStreamItem = Schema.Union([FileManagerSessionReady, FileManagerEvent]);
export type FileManagerStreamItem = typeof FileManagerStreamItem.Type;

export const FileManagerHostInfo = Schema.Struct({
  homePath: TrimmedNonEmptyString,
});
export type FileManagerHostInfo = typeof FileManagerHostInfo.Type;

/**
 * The transport failed, as opposed to the file manager answering a failure
 * reply: a session the host could not open, or a handler that threw past the
 * registry's own guard.
 */
export class FileManagerError extends Schema.TaggedErrorClass<FileManagerError>()(
  "FileManagerError",
  {
    sessionId: Schema.optional(FileManagerSessionId),
    channel: Schema.optional(Schema.String),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The file manager's values on the wire.
 *
 * In the standalone the replies cross Electron's IPC by structured clone,
 * which carries `undefined` and byte arrays; the WebSocket carries JSON,
 * which has neither, and a reply with either dies in the RPC encoder as a
 * defect the client cannot act on. `describe` answers with a file's first
 * bytes for the content sniff. So on the way out bytes become
 * `{ $symmetriaBytes: <base64> }` — a key no file manager payload can carry —
 * and `undefined` and the numbers JSON cannot write (non-finite, bigint)
 * become `null`; on the way in the bytes come back. A value with nothing to
 * change is returned as the same reference, so a large listing costs one
 * walk and no copy.
 */
const FILE_MANAGER_BYTES_KEY = "$symmetriaBytes";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mapArray(values: ReadonlyArray<unknown>, map: (value: unknown) => unknown): unknown {
  let copy: unknown[] | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const mapped = map(values[index]);
    if (mapped !== values[index] && copy === null) copy = values.slice(0, index);
    if (copy !== null) copy.push(mapped);
  }
  return copy ?? values;
}

function mapObject(record: Record<string, unknown>, map: (value: unknown) => unknown): unknown {
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(record)) {
    const mapped = map(record[key]);
    if (mapped !== record[key] && copy === null) copy = { ...record };
    if (copy !== null) copy[key] = mapped;
  }
  return copy ?? record;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toFileManagerWireValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return null;
  if (value instanceof Uint8Array) return { [FILE_MANAGER_BYTES_KEY]: bytesToBase64(value) };
  if (Array.isArray(value)) return mapArray(value, toFileManagerWireValue);
  if (isPlainObject(value)) return mapObject(value, toFileManagerWireValue);
  return value;
}

export function fromFileManagerWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return mapArray(value, fromFileManagerWireValue);
  if (!isPlainObject(value)) return value;
  const encoded = value[FILE_MANAGER_BYTES_KEY];
  if (typeof encoded === "string" && Object.keys(value).length === 1) return base64ToBytes(encoded);
  return mapObject(value, fromFileManagerWireValue);
}
