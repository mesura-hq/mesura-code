import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as EditorSessionManager from "../editor/Manager.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "attachment"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  /** Closes every preview session of the thread; server browser tabs end with them. */
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    // Mesura: the thread's embedded Neovim closes with its terminals. Optional so
    // layers without the editor (tests, headless tools) keep working.
    const editorSessions = yield* Effect.serviceOption(EditorSessionManager.EditorSessionManager);
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    return {
      cleanupTerminals: (threadId: string) =>
        terminals.close({ threadId, deleteHistory: true }).pipe(
          Effect.mapError(
            (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
          ),
          // Mesura: archive and deletion remove the thread from view, so the
          // editor session it held goes with its terminals.
          Effect.andThen(
            Option.isSome(editorSessions)
              ? editorSessions.value.closeThread({ threadId: ThreadId.make(threadId) })
              : Effect.void,
          ),
        ),
      cleanupPreviews: (threadId: string) =>
        previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          ),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return path === null
              ? Effect.void
              : fileSystem
                  .remove(path, { force: true })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                    ),
                  );
          },
          { discard: true, concurrency: 4 },
        ),
    };
  }),
);
