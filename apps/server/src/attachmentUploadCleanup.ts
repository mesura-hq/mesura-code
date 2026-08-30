import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ATTACHMENT_UPLOAD_EXPIRY_MS, makeAttachmentUploadStore } from "./attachmentUploadStore.ts";
import { ServerConfig } from "./config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "./persistence/Services/OrchestrationCommandReceipts.ts";

const attachmentUploadCleanup = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const commandReceipts = yield* OrchestrationCommandReceiptRepository;
    const store = yield* makeAttachmentUploadStore({
      uploadsDir: config.attachmentUploadsDir,
      attachmentsDir: config.attachmentsDir,
    });
    const cleanup = store
      .pruneExpired(undefined, {
        isCommandAccepted: (commandId) =>
          commandReceipts.getByCommandId({ commandId }).pipe(
            Effect.map(
              Option.match({
                onNone: () => false,
                onSome: (receipt) => receipt.status === "accepted",
              }),
            ),
            Effect.catch((cause) =>
              Effect.logWarning("attachment.upload.receipt-check-failed", {
                commandId,
                cause,
              }).pipe(Effect.as(true)),
            ),
          ),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("attachment.upload.cleanup-failed", { reason: error.reason }),
        ),
      );
    yield* cleanup.pipe(
      Effect.repeat(Schedule.spaced(ATTACHMENT_UPLOAD_EXPIRY_MS / 24)),
      Effect.forkScoped,
    );
  }),
);

export const attachmentUploadCleanupLayer = attachmentUploadCleanup.pipe(
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(SqlitePersistenceLayerLive),
);
