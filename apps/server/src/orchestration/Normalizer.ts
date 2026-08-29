import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { type AttachmentUploadStore, makeAttachmentUploadStore } from "../attachmentUploadStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

const updateUploadedAttachmentClaims = Effect.fn("Normalizer.updateUploadedAttachmentClaims")(
  function* (
    command: ClientOrchestrationCommand,
    operation: "releaseClaim" | "commitClaim",
    providedStore?: AttachmentUploadStore,
  ) {
    if (command.type !== "thread.turn.start") return;
    const uploadedAttachments = command.message.attachments.filter(
      (attachment) => attachment.type === "uploaded",
    );
    if (uploadedAttachments.length === 0) return;
    const store = providedStore ?? (yield* makeAttachmentUploadStoreFromConfig);
    yield* Effect.forEach(
      uploadedAttachments,
      (attachment) =>
        store[operation]({ uploadId: attachment.uploadId, claimToken: command.commandId }).pipe(
          Effect.ignore,
        ),
      { concurrency: 1, discard: true },
    );
  },
);

const makeAttachmentUploadStoreFromConfig = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  return yield* makeAttachmentUploadStore({
    uploadsDir: serverConfig.attachmentUploadsDir,
    attachmentsDir: serverConfig.attachmentsDir,
  });
});

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    const attachmentUploadStore = canonicalCommand.message.attachments.some(
      (attachment) => attachment.type === "uploaded",
    )
      ? yield* makeAttachmentUploadStore({
          uploadsDir: serverConfig.attachmentUploadsDir,
          attachmentsDir: serverConfig.attachmentsDir,
        })
      : undefined;

    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type === "uploaded") {
            if (!attachmentUploadStore) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Attachment upload storage is unavailable.",
              });
            }
            return yield* attachmentUploadStore
              .claim({
                uploadId: attachment.uploadId,
                threadId: canonicalCommand.threadId,
                claimToken: canonicalCommand.commandId,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestrationDispatchCommandError({
                      message: error.message,
                    }),
                ),
              );
          }
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.onError(() =>
        attachmentUploadStore
          ? updateUploadedAttachmentClaims(
              canonicalCommand,
              "releaseClaim",
              attachmentUploadStore,
            ).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

export const rollbackDispatchCommandAttachments = (command: ClientOrchestrationCommand) =>
  updateUploadedAttachmentClaims(command, "releaseClaim").pipe(Effect.ignore);

export const commitDispatchCommandAttachments = (command: ClientOrchestrationCommand) =>
  updateUploadedAttachmentClaims(command, "commitClaim").pipe(Effect.ignore);
