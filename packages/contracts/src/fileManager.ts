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
