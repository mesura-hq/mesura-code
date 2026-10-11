import {
  CommandId,
  describeProjectIconChange,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
} from "../../../attachmentStore.ts";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectFaviconResolver } from "../../../project/ProjectFaviconResolver.ts";
import {
  locateProjectIconSource,
  readProjectIconSource,
  writeProjectIconFile,
} from "../../../project/ProjectIconFile.ts";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { ProjectIconsToolkit, ProjectIconUpdateError } from "./tools.ts";

const updateError = (detail: string) => () => new ProjectIconUpdateError({ detail });
const errorDetail = (fallback: string) => (error: unknown) =>
  new ProjectIconUpdateError({ detail: error instanceof Error ? error.message : fallback });

export const ProjectIconsToolkitHandlersLive = ProjectIconsToolkit.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const snapshots = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const resolver = yield* ProjectFaviconResolver;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;

    /** Only an attachment recorded on one of this thread's own messages may be imported. */
    const requireThreadAttachment = Effect.fn("ProjectIconsToolkit.requireThreadAttachment")(
      function* (thread: OrchestrationThreadShell, fileName: string) {
        const attachmentId = parseAttachmentIdFromRelativePath(fileName);
        const recorded =
          attachmentId === null
            ? Option.none()
            : yield* snapshots
                .getThreadMessageAttachment({ threadId: thread.id, attachmentId })
                .pipe(Effect.mapError(updateError("Could not read this thread's attachments.")));
        if (Option.isNone(recorded) || attachmentRelativePath(recorded.value) !== fileName) {
          return yield* new ProjectIconUpdateError({
            detail: "That image is not attached to this thread.",
          });
        }
      },
    );

    /** Resolves the saved path for an image, importing it when it lies outside the project. */
    const prepareImage = Effect.fn("ProjectIconsToolkit.prepareImage")(function* (
      thread: OrchestrationThreadShell,
      project: OrchestrationProjectShell,
      imagePath: string,
    ) {
      const source = yield* Effect.tryPromise({
        try: () =>
          locateProjectIconSource({
            workspaceRoot: project.workspaceRoot,
            workingDirectory: thread.worktreePath ?? project.workspaceRoot,
            attachmentsDirectory: config.attachmentsDir,
            imagePath,
          }),
        catch: errorDetail("Could not read this image."),
      });
      if (source.kind === "project") return { faviconPath: source.faviconPath, imported: false };
      if (source.kind === "attachment") yield* requireThreadAttachment(thread, source.fileName);
      // Read only now, after ownership: the file is checked again as it is read.
      const image = yield* readProjectIconSource(source).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError(errorDetail("Could not read this image.")),
      );
      const faviconPath = yield* Effect.tryPromise({
        try: () => writeProjectIconFile({ workspaceRoot: project.workspaceRoot, ...image }),
        catch: errorDetail("Could not copy this image into the project."),
      });
      return { faviconPath, imported: true };
    });

    return {
      set_project_icon: Effect.fn("ProjectIconsToolkit.setProjectIcon")(function* (input) {
        const scope = yield* requireMcpCapability("project-icons");
        const thread = yield* snapshots
          .getThreadShellById(scope.threadId)
          .pipe(Effect.mapError(updateError("Could not read this thread.")));
        if (Option.isNone(thread))
          return yield* new ProjectIconUpdateError({ detail: "This thread no longer exists." });
        const project = yield* snapshots
          .getProjectShellById(thread.value.projectId)
          .pipe(Effect.mapError(updateError("Could not read this project.")));
        if (Option.isNone(project))
          return yield* new ProjectIconUpdateError({ detail: "This project no longer exists." });
        const selected =
          input.imagePath === null
            ? { faviconPath: null, imported: false }
            : yield* prepareImage(thread.value, project.value, input.imagePath);
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* engine
          .dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(`server:project-icon:${uuid}`),
            projectId: project.value.id,
            faviconPath: selected.faviconPath,
            projectIcon: null,
            // The decider refuses an image prepared against a root the project
            // left, and a save or reset of a project deleted since it was read.
            expectedWorkspaceRoot: project.value.workspaceRoot,
          })
          .pipe(
            Effect.mapError(
              updateError(
                "The project icon was not saved. The project may have moved or been deleted.",
              ),
            ),
          );
        const effective = yield* resolver
          .resolveEffectiveImage(project.value.workspaceRoot, selected.faviconPath ?? undefined, {
            fresh: true,
          })
          .pipe(Effect.orElseSucceed(() => null));
        const effectiveSource = effective?.source ?? "initials";
        return {
          projectId: project.value.id,
          ...selected,
          effectiveSource,
          message: describeProjectIconChange(
            selected.faviconPath === null ? "reset" : "saved",
            effectiveSource,
          ),
        };
      }),
    };
  }),
);
