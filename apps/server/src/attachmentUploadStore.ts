// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AttachmentUploadMetadata,
  AttachmentUploadId,
  AttachmentUploadKind,
  ChatAttachment,
  type ChatAttachment as ChatAttachmentType,
  CommandId,
  type CommandId as CommandIdType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { createAttachmentId, resolveAttachmentPath } from "./attachmentStore.ts";

export const ATTACHMENT_UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1_000;

const StoredAttachmentUpload = Schema.Struct({
  uploadId: AttachmentUploadId,
  threadId: ThreadId,
  kind: AttachmentUploadKind,
  name: Schema.NonEmptyString,
  mimeType: Schema.NonEmptyString,
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  offsetBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literals(["uploading", "ready", "claimed", "releasing", "committed"]),
  createdAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
  attachment: Schema.optional(ChatAttachment),
  claimToken: Schema.optional(CommandId),
});
type StoredAttachmentUpload = typeof StoredAttachmentUpload.Type;

const decodeStoredAttachmentUpload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredAttachmentUpload),
);
const decodeAttachmentUploadId = Schema.decodeUnknownEffect(AttachmentUploadId);
const decodeAttachmentUploadMetadata = Schema.decodeUnknownEffect(AttachmentUploadMetadata);
const decodeChatAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const encodeStoredAttachmentUpload = Schema.encodeSync(
  Schema.fromJsonString(StoredAttachmentUpload),
);

export const AttachmentUploadStoreErrorReason = Schema.Literals([
  "invalid-input",
  "not-found",
  "offset-mismatch",
  "size-limit",
  "incomplete",
  "thread-mismatch",
  "already-claimed",
  "storage-failure",
]);
export type AttachmentUploadStoreErrorReason = typeof AttachmentUploadStoreErrorReason.Type;

export class AttachmentUploadStoreError extends Schema.TaggedErrorClass<AttachmentUploadStoreError>()(
  "AttachmentUploadStoreError",
  {
    reason: AttachmentUploadStoreErrorReason,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export const isAttachmentUploadStoreError = Schema.is(AttachmentUploadStoreError);

export interface AttachmentUploadSnapshot {
  readonly uploadId: AttachmentUploadId;
  readonly threadId: ThreadIdType;
  readonly kind: AttachmentUploadKind;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly offsetBytes: number;
  readonly status: "uploading" | "ready" | "claimed" | "releasing" | "committed";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly attachment?: ChatAttachmentType;
}

export interface AttachmentUploadStore {
  readonly create: (input: {
    readonly threadId: ThreadIdType;
    readonly kind: AttachmentUploadKind;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }) => Effect.Effect<AttachmentUploadSnapshot, AttachmentUploadStoreError>;
  readonly inspect: (
    uploadId: AttachmentUploadId,
  ) => Effect.Effect<AttachmentUploadSnapshot, AttachmentUploadStoreError>;
  readonly append: <E, R>(input: {
    readonly uploadId: AttachmentUploadId;
    readonly offsetBytes: number;
    readonly body: Stream.Stream<Uint8Array, E, R>;
  }) => Effect.Effect<AttachmentUploadSnapshot, AttachmentUploadStoreError | E, R>;
  readonly cancel: (
    uploadId: AttachmentUploadId,
  ) => Effect.Effect<void, AttachmentUploadStoreError>;
  readonly claim: (input: {
    readonly uploadId: AttachmentUploadId;
    readonly threadId: ThreadIdType;
    readonly claimToken: CommandIdType;
  }) => Effect.Effect<ChatAttachmentType, AttachmentUploadStoreError>;
  readonly releaseClaim: (input: {
    readonly uploadId: AttachmentUploadId;
    readonly claimToken: CommandIdType;
  }) => Effect.Effect<void, AttachmentUploadStoreError>;
  readonly commitClaim: (input: {
    readonly uploadId: AttachmentUploadId;
    readonly claimToken: CommandIdType;
  }) => Effect.Effect<void, AttachmentUploadStoreError>;
  readonly resolveClaimedPath: (
    uploadId: AttachmentUploadId,
  ) => Effect.Effect<string, AttachmentUploadStoreError>;
  readonly pruneExpired: (
    nowMs?: number,
    options?: {
      readonly isCommandAccepted: (commandId: CommandIdType) => Effect.Effect<boolean>;
    },
  ) => Effect.Effect<ReadonlyArray<string>, AttachmentUploadStoreError>;
}

const storageError = (message: string, cause: unknown) =>
  new AttachmentUploadStoreError({ reason: "storage-failure", message, cause });

function safeDisplayName(name: string): string {
  const normalized = name.trim().replaceAll("\\", "/");
  return (
    normalized
      .split("/")
      .findLast((segment) => segment.length > 0)
      ?.slice(0, 255) || "attachment.bin"
  );
}

function snapshot(metadata: StoredAttachmentUpload): AttachmentUploadSnapshot {
  return {
    uploadId: metadata.uploadId,
    threadId: metadata.threadId,
    kind: metadata.kind,
    name: metadata.name,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
    offsetBytes: metadata.offsetBytes,
    status: metadata.status,
    createdAtMs: metadata.createdAtMs,
    updatedAtMs: metadata.updatedAtMs,
    ...(metadata.attachment ? { attachment: metadata.attachment } : {}),
  };
}

interface AttachmentUploadLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
}

const attachmentUploadLocks = new Map<string, AttachmentUploadLockEntry>();

const withAttachmentUploadLock = <A, E, R>(
  uploadId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const existing = attachmentUploadLocks.get(uploadId);
      if (existing) {
        existing.users += 1;
        return existing;
      }
      const created = { semaphore: Semaphore.makeUnsafe(1), users: 1 };
      attachmentUploadLocks.set(uploadId, created);
      return created;
    }),
    (entry) => entry.semaphore.withPermit(effect),
    (entry) =>
      Effect.sync(() => {
        entry.users -= 1;
        if (entry.users === 0 && attachmentUploadLocks.get(uploadId) === entry) {
          attachmentUploadLocks.delete(uploadId);
        }
      }),
  );

export const makeAttachmentUploadStore = Effect.fn("AttachmentUploadStore.make")(function* (paths: {
  readonly uploadsDir: string;
  readonly attachmentsDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.all(
    [
      fileSystem.makeDirectory(paths.uploadsDir, { recursive: true }),
      fileSystem.makeDirectory(paths.attachmentsDir, { recursive: true }),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.mapError((cause) => storageError("Failed to create attachment directories.", cause)),
  );

  const metadataPath = (uploadId: string) => path.join(paths.uploadsDir, `${uploadId}.json`);
  const bodyPath = (uploadId: string) => path.join(paths.uploadsDir, `${uploadId}.part`);

  const persist = Effect.fn("AttachmentUploadStore.persist")(function* (
    metadata: StoredAttachmentUpload,
  ) {
    const targetPath = metadataPath(metadata.uploadId);
    const temporaryPath = `${targetPath}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fileSystem.writeFileString(temporaryPath, encodeStoredAttachmentUpload(metadata)).pipe(
      Effect.andThen(fileSystem.rename(temporaryPath, targetPath)),
      Effect.mapError((cause) =>
        storageError("Failed to persist attachment upload metadata.", cause),
      ),
    );
  });

  const readPersisted = Effect.fn("AttachmentUploadStore.readPersisted")(function* (
    uploadId: AttachmentUploadId,
  ) {
    const encoded = yield* fileSystem.readFileString(metadataPath(uploadId)).pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentUploadStoreError({
            reason: "not-found",
            message: `Attachment upload '${uploadId}' was not found.`,
            cause,
          }),
      ),
    );
    return yield* decodeStoredAttachmentUpload(encoded).pipe(
      Effect.mapError((cause) => storageError("Attachment upload metadata is invalid.", cause)),
    );
  });

  const recoverClaimedFile = Effect.fn("AttachmentUploadStore.recoverClaimedFile")(function* (
    metadata: StoredAttachmentUpload,
  ) {
    if ((metadata.status !== "claimed" && metadata.status !== "committed") || !metadata.attachment)
      return metadata;
    const claimedPath = resolveAttachmentPath({
      attachmentsDir: paths.attachmentsDir,
      attachment: metadata.attachment,
    });
    if (!claimedPath) {
      return yield* new AttachmentUploadStoreError({
        reason: "storage-failure",
        message: "Failed to resolve the claimed attachment path.",
      });
    }
    const claimedExists = yield* fileSystem
      .exists(claimedPath)
      .pipe(
        Effect.mapError((cause) => storageError("Failed to inspect a claimed attachment.", cause)),
      );
    const stagedExists = yield* fileSystem
      .exists(bodyPath(metadata.uploadId))
      .pipe(
        Effect.mapError((cause) => storageError("Failed to inspect staged upload bytes.", cause)),
      );
    if (!claimedExists && stagedExists) {
      yield* fileSystem
        .rename(bodyPath(metadata.uploadId), claimedPath)
        .pipe(
          Effect.mapError((cause) =>
            storageError("Failed to recover a claimed attachment.", cause),
          ),
        );
    }
    return metadata;
  });

  const recoverReleasingFile = Effect.fn("AttachmentUploadStore.recoverReleasingFile")(function* (
    metadata: StoredAttachmentUpload,
  ) {
    if (metadata.status !== "releasing" || !metadata.attachment) return metadata;
    const claimedPath = resolveAttachmentPath({
      attachmentsDir: paths.attachmentsDir,
      attachment: metadata.attachment,
    });
    if (!claimedPath) {
      return yield* new AttachmentUploadStoreError({
        reason: "storage-failure",
        message: "Failed to resolve the releasing attachment path.",
      });
    }
    const stagedPath = bodyPath(metadata.uploadId);
    const stagedExists = yield* fileSystem
      .exists(stagedPath)
      .pipe(
        Effect.mapError((cause) => storageError("Failed to inspect staged upload bytes.", cause)),
      );
    if (!stagedExists) {
      yield* fileSystem
        .rename(claimedPath, stagedPath)
        .pipe(Effect.mapError((cause) => storageError("Failed to release claimed bytes.", cause)));
    }
    const { attachment: _attachment, claimToken: _claimToken, ...released } = metadata;
    const ready: StoredAttachmentUpload = { ...released, status: "ready" };
    yield* persist(ready);
    return ready;
  });

  const inspectUnlocked = Effect.fn("AttachmentUploadStore.inspectUnlocked")(function* (
    uploadId: AttachmentUploadId,
  ) {
    let metadata = yield* readPersisted(uploadId);
    if (metadata.status === "releasing") {
      metadata = yield* recoverReleasingFile(metadata);
    }
    if (metadata.status === "claimed" || metadata.status === "committed") {
      return yield* recoverClaimedFile(metadata);
    }
    const info = yield* fileSystem
      .stat(bodyPath(uploadId))
      .pipe(
        Effect.mapError((cause) =>
          storageError("Failed to inspect attachment upload bytes.", cause),
        ),
      );
    const diskOffset = Number(info.size);
    if (!Number.isSafeInteger(diskOffset) || diskOffset > metadata.sizeBytes) {
      return yield* new AttachmentUploadStoreError({
        reason: "storage-failure",
        message: "Attachment upload bytes exceed the declared length.",
      });
    }
    const recoveredStatus = diskOffset === metadata.sizeBytes ? "ready" : "uploading";
    if (diskOffset !== metadata.offsetBytes || recoveredStatus !== metadata.status) {
      metadata = { ...metadata, offsetBytes: diskOffset, status: recoveredStatus };
      yield* persist(metadata);
    }
    return metadata;
  });

  const inspect: AttachmentUploadStore["inspect"] = (uploadId) =>
    withAttachmentUploadLock(uploadId, Effect.map(inspectUnlocked(uploadId), snapshot));

  const create: AttachmentUploadStore["create"] = Effect.fn("AttachmentUploadStore.create")(
    function* (input) {
      const validated = yield* decodeAttachmentUploadMetadata(input).pipe(
        Effect.mapError(
          (cause) =>
            new AttachmentUploadStoreError({
              reason: "invalid-input",
              message: "Attachment upload metadata is invalid.",
              cause,
            }),
        ),
      );
      const maxBytes =
        validated.kind === "image"
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      if (
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes <= 0 ||
        input.sizeBytes > maxBytes ||
        (validated.kind === "image" &&
          (!/^image\//i.test(validated.mimeType) || validated.mimeType.length > 100))
      ) {
        return yield* new AttachmentUploadStoreError({
          reason: input.sizeBytes > maxBytes ? "size-limit" : "invalid-input",
          message: "Attachment upload metadata is invalid.",
        });
      }
      const uploadId = AttachmentUploadId.make(`upload-${NodeCrypto.randomUUID()}`);
      const nowMs = yield* Clock.currentTimeMillis;
      const metadata: StoredAttachmentUpload = {
        uploadId,
        threadId: validated.threadId,
        kind: validated.kind,
        name: safeDisplayName(validated.name),
        mimeType: validated.mimeType.toLowerCase(),
        sizeBytes: input.sizeBytes,
        offsetBytes: 0,
        status: "uploading",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      yield* fileSystem
        .writeFile(bodyPath(uploadId), new Uint8Array())
        .pipe(
          Effect.mapError((cause) =>
            storageError("Failed to initialize attachment upload.", cause),
          ),
        );
      yield* persist(metadata);
      return snapshot(metadata);
    },
  );

  const append: AttachmentUploadStore["append"] = (input) =>
    withAttachmentUploadLock(
      input.uploadId,
      Effect.gen(function* () {
        const metadata = yield* inspectUnlocked(input.uploadId);
        if (metadata.status !== "uploading") {
          return yield* new AttachmentUploadStoreError({
            reason: "offset-mismatch",
            message: "Attachment upload is already complete.",
          });
        }
        if (input.offsetBytes !== metadata.offsetBytes) {
          return yield* new AttachmentUploadStoreError({
            reason: "offset-mismatch",
            message: `Expected upload offset ${metadata.offsetBytes}.`,
          });
        }

        let writtenBytes = 0;
        const remainingBytes = metadata.sizeBytes - metadata.offsetBytes;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem
              .open(bodyPath(input.uploadId), { flag: "a" })
              .pipe(
                Effect.mapError((cause) =>
                  storageError("Failed to open attachment upload bytes.", cause),
                ),
              );
            yield* Stream.runForEach(input.body, (chunk) => {
              if (writtenBytes + chunk.byteLength > remainingBytes) {
                return Effect.fail(
                  new AttachmentUploadStoreError({
                    reason: "size-limit",
                    message: "Attachment upload exceeds its declared length.",
                  }),
                );
              }
              writtenBytes += chunk.byteLength;
              return file
                .writeAll(chunk)
                .pipe(
                  Effect.mapError((cause) =>
                    storageError("Failed to append attachment upload bytes.", cause),
                  ),
                );
            });
            yield* file.sync.pipe(
              Effect.mapError((cause) =>
                storageError("Failed to synchronize attachment upload bytes.", cause),
              ),
            );
          }),
        );

        const nowMs = yield* Clock.currentTimeMillis;
        const offsetBytes = metadata.offsetBytes + writtenBytes;
        const updated: StoredAttachmentUpload = {
          ...metadata,
          offsetBytes,
          status: offsetBytes === metadata.sizeBytes ? "ready" : "uploading",
          updatedAtMs: nowMs,
        };
        yield* persist(updated);
        return snapshot(updated);
      }),
    );

  const cancel: AttachmentUploadStore["cancel"] = (uploadId) =>
    withAttachmentUploadLock(
      uploadId,
      Effect.gen(function* () {
        const metadata = yield* inspectUnlocked(uploadId);
        if (metadata.status === "claimed" || metadata.status === "committed") {
          return yield* new AttachmentUploadStoreError({
            reason: "already-claimed",
            message: "A claimed attachment upload cannot be cancelled.",
          });
        }
        yield* Effect.all(
          [
            fileSystem.remove(metadataPath(uploadId), { force: true }),
            fileSystem.remove(bodyPath(uploadId), { force: true }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.mapError((cause) => storageError("Failed to cancel attachment upload.", cause)),
        );
      }),
    );

  const claim: AttachmentUploadStore["claim"] = (input) =>
    withAttachmentUploadLock(
      input.uploadId,
      Effect.gen(function* () {
        const metadata = yield* inspectUnlocked(input.uploadId);
        if (metadata.threadId !== input.threadId) {
          return yield* new AttachmentUploadStoreError({
            reason: "thread-mismatch",
            message: "Attachment upload belongs to a different thread.",
          });
        }
        if (
          (metadata.status === "claimed" || metadata.status === "committed") &&
          metadata.attachment
        ) {
          if (metadata.claimToken !== input.claimToken) {
            return yield* new AttachmentUploadStoreError({
              reason: "already-claimed",
              message: "Attachment upload was claimed by a different command.",
            });
          }
          yield* recoverClaimedFile(metadata);
          return metadata.attachment;
        }
        if (metadata.status !== "ready") {
          return yield* new AttachmentUploadStoreError({
            reason: "incomplete",
            message: "Attachment upload is not complete.",
          });
        }
        const attachmentId = createAttachmentId(metadata.threadId);
        if (!attachmentId) {
          return yield* new AttachmentUploadStoreError({
            reason: "invalid-input",
            message: "Failed to create an attachment identifier.",
          });
        }
        const attachment = yield* decodeChatAttachment({
          type: metadata.kind,
          id: attachmentId,
          name: metadata.name,
          mimeType: metadata.mimeType,
          sizeBytes: metadata.sizeBytes,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new AttachmentUploadStoreError({
                reason: "invalid-input",
                message: "Attachment upload metadata cannot create an attachment.",
                cause,
              }),
          ),
        );
        const claimedPath = resolveAttachmentPath({
          attachmentsDir: paths.attachmentsDir,
          attachment,
        });
        if (!claimedPath) {
          return yield* new AttachmentUploadStoreError({
            reason: "storage-failure",
            message: "Failed to resolve the claimed attachment path.",
          });
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const claimed: StoredAttachmentUpload = {
          ...metadata,
          status: "claimed",
          attachment,
          claimToken: input.claimToken,
          updatedAtMs: nowMs,
        };
        yield* persist(claimed);
        yield* fileSystem
          .rename(bodyPath(input.uploadId), claimedPath)
          .pipe(
            Effect.mapError((cause) =>
              storageError("Failed to materialize attachment bytes.", cause),
            ),
          );
        return attachment;
      }),
    );

  const releaseClaim: AttachmentUploadStore["releaseClaim"] = (input) =>
    withAttachmentUploadLock(
      input.uploadId,
      Effect.gen(function* () {
        let metadata = yield* readPersisted(input.uploadId);
        if (metadata.status === "releasing") {
          metadata = yield* recoverReleasingFile(metadata);
        }
        if (metadata.status !== "claimed" || metadata.claimToken !== input.claimToken) return;
        const releasing: StoredAttachmentUpload = { ...metadata, status: "releasing" };
        yield* persist(releasing);
        yield* recoverReleasingFile(releasing);
      }),
    );

  const commitClaim: AttachmentUploadStore["commitClaim"] = (input) =>
    withAttachmentUploadLock(
      input.uploadId,
      Effect.gen(function* () {
        const metadata = yield* inspectUnlocked(input.uploadId);
        if (metadata.claimToken !== input.claimToken) {
          return yield* new AttachmentUploadStoreError({
            reason: "already-claimed",
            message: "Attachment upload was claimed by a different command.",
          });
        }
        if (metadata.status === "committed") return;
        if (metadata.status !== "claimed") {
          return yield* new AttachmentUploadStoreError({
            reason: "incomplete",
            message: "Attachment upload has not been claimed.",
          });
        }
        yield* persist({ ...metadata, status: "committed" });
      }),
    );

  const resolveClaimedPath: AttachmentUploadStore["resolveClaimedPath"] = (uploadId) =>
    withAttachmentUploadLock(
      uploadId,
      Effect.gen(function* () {
        const metadata = yield* inspectUnlocked(uploadId);
        if (
          (metadata.status !== "claimed" && metadata.status !== "committed") ||
          !metadata.attachment
        ) {
          return yield* new AttachmentUploadStoreError({
            reason: "incomplete",
            message: "Attachment upload has not been claimed.",
          });
        }
        const claimedPath = resolveAttachmentPath({
          attachmentsDir: paths.attachmentsDir,
          attachment: metadata.attachment,
        });
        if (!claimedPath) {
          return yield* new AttachmentUploadStoreError({
            reason: "storage-failure",
            message: "Failed to resolve the claimed attachment path.",
          });
        }
        return claimedPath;
      }),
    );

  const pruneExpired: AttachmentUploadStore["pruneExpired"] = (providedNowMs, options) =>
    Effect.gen(function* () {
      const nowMs = providedNowMs ?? (yield* Clock.currentTimeMillis);
      const entries = yield* fileSystem
        .readDirectory(paths.uploadsDir)
        .pipe(
          Effect.mapError((cause) => storageError("Failed to list attachment uploads.", cause)),
        );
      const removed: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const uploadId = entry.slice(0, -".json".length);
        const decodedId = yield* decodeAttachmentUploadId(uploadId).pipe(Effect.option);
        if (decodedId._tag === "None") continue;
        yield* withAttachmentUploadLock(
          decodedId.value,
          Effect.gen(function* () {
            const metadata = yield* inspectUnlocked(decodedId.value);
            if (nowMs - metadata.updatedAtMs <= ATTACHMENT_UPLOAD_EXPIRY_MS) return;
            if (metadata.status === "claimed") {
              if (!metadata.claimToken || !options) return;
              if (yield* options.isCommandAccepted(metadata.claimToken)) {
                yield* fileSystem
                  .remove(metadataPath(decodedId.value), { force: true })
                  .pipe(
                    Effect.mapError((cause) =>
                      storageError("Failed to remove committed upload metadata.", cause),
                    ),
                  );
                removed.push(decodedId.value);
                return;
              }
              if (metadata.attachment) {
                const claimedPath = resolveAttachmentPath({
                  attachmentsDir: paths.attachmentsDir,
                  attachment: metadata.attachment,
                });
                if (claimedPath) {
                  yield* fileSystem
                    .remove(claimedPath, { force: true })
                    .pipe(
                      Effect.mapError((cause) =>
                        storageError("Failed to remove abandoned claimed bytes.", cause),
                      ),
                    );
                }
              }
            }
            yield* fileSystem
              .remove(metadataPath(decodedId.value), { force: true })
              .pipe(
                Effect.mapError((cause) =>
                  storageError("Failed to remove expired upload metadata.", cause),
                ),
              );
            yield* fileSystem
              .remove(bodyPath(decodedId.value), { force: true })
              .pipe(
                Effect.mapError((cause) =>
                  storageError("Failed to remove expired upload bytes.", cause),
                ),
              );
            removed.push(decodedId.value);
          }),
        );
      }
      for (const entry of entries) {
        const isTemporaryMetadata = entry.endsWith(".tmp") && entry.includes(".json.");
        const isStagedBody = entry.endsWith(".part");
        if (!isTemporaryMetadata && !isStagedBody) continue;
        if (isStagedBody) {
          const uploadId = entry.slice(0, -".part".length);
          const hasMetadata = yield* fileSystem
            .exists(path.join(paths.uploadsDir, `${uploadId}.json`))
            .pipe(
              Effect.mapError((cause) => storageError("Failed to inspect upload metadata.", cause)),
            );
          if (hasMetadata) continue;
        }
        const artifactPath = path.join(paths.uploadsDir, entry);
        const artifactExists = yield* fileSystem
          .exists(artifactPath)
          .pipe(
            Effect.mapError((cause) => storageError("Failed to inspect upload artifact.", cause)),
          );
        if (!artifactExists) continue;
        const info = yield* fileSystem
          .stat(artifactPath)
          .pipe(
            Effect.mapError((cause) => storageError("Failed to inspect upload artifact.", cause)),
          );
        const modifiedAtMs = Option.getOrUndefined(info.mtime)?.getTime();
        if (modifiedAtMs === undefined || nowMs - modifiedAtMs <= ATTACHMENT_UPLOAD_EXPIRY_MS) {
          continue;
        }
        yield* fileSystem
          .remove(artifactPath, { force: true })
          .pipe(
            Effect.mapError((cause) => storageError("Failed to remove upload artifact.", cause)),
          );
      }
      return removed;
    });

  return {
    create,
    inspect,
    append,
    cancel,
    claim,
    releaseClaim,
    commitClaim,
    resolveClaimedPath,
    pruneExpired,
  } satisfies AttachmentUploadStore;
});
