import {
  CommandId,
  describeProjectIconChange,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type ProjectIconEffectiveSource,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { attachmentRelativePath } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectFaviconResolver } from "../../../project/ProjectFaviconResolver.ts";
import {
  locateProjectIconSource,
  readProjectIconSource,
  writeProjectIconFile,
} from "../../../project/ProjectIconFile.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProjectIconsToolkit, ProjectIconUpdateError } from "./tools.ts";

const updateError = (detail: string) => () => new ProjectIconUpdateError({ detail });
const errorDetail = (fallback: string) => (error: unknown) =>
  new ProjectIconUpdateError({ detail: error instanceof Error ? error.message : fallback });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const resolver = yield* ProjectFaviconResolver;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;

  /** Only an attachment recorded on one of this thread's own user messages may be imported. */
  const requireThreadAttachment = Effect.fn("ProjectIconsToolkit.requireThreadAttachment")(
    function* (thread: OrchestrationV2ThreadShell, fileName: string) {
      const { messages } = yield* threads
        .getThreadRecords(thread.id, ["messages"], { messageRoles: ["user"] })
        .pipe(Effect.mapError(updateError("Could not read this thread's attachments.")));
      const recorded = messages.some(
        (message) =>
          message.role === "user" &&
          message.attachments.some((attachment) => attachmentRelativePath(attachment) === fileName),
      );
      if (!recorded) {
        return yield* new ProjectIconUpdateError({
          detail: "That image is not attached to this thread.",
        });
      }
    },
  );

  /** Resolves the saved path for an image, importing it when it lies outside the project. */
  const prepareImage = Effect.fn("ProjectIconsToolkit.prepareImage")(function* (
    thread: OrchestrationV2ThreadShell,
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

  const setProjectIcon = Effect.fn("ProjectIconsToolkit.setProjectIcon")(function* (input: {
    readonly imagePath: string | null;
  }) {
    const scope = yield* requireMcpCapability("project-icons");
    // The access gate already refused a caller without a thread.
    const threadId = scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new ProjectIconUpdateError({ detail: "This tool needs a calling thread." });
    }
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(updateError("Could not read this thread.")));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new ProjectIconUpdateError({ detail: "This thread no longer exists." });
    }
    const project = yield* projects
      .getShell(thread.projectId)
      .pipe(Effect.mapError(updateError("Could not read this project.")));
    if (Option.isNone(project)) {
      return yield* new ProjectIconUpdateError({ detail: "This project no longer exists." });
    }
    const selected =
      input.imagePath === null
        ? { faviconPath: null, imported: false }
        : yield* prepareImage(thread, project.value, input.imagePath);
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* projects
      .update({
        commandId: CommandId.make(`server:project-icon:${uuid}`),
        projectId: project.value.id,
        faviconPath: selected.faviconPath,
        projectIcon: null,
        // The planner refuses an image prepared against a root the project
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
    const effectiveSource: ProjectIconEffectiveSource = effective?.source ?? "initials";
    return {
      projectId: project.value.id,
      ...selected,
      effectiveSource,
      message: describeProjectIconChange(
        selected.faviconPath === null ? "reset" : "saved",
        effectiveSource,
      ),
    };
  });

  return {
    // Changes only the calling thread's own project, so it acts as that
    // thread: a live thread caller, never an outside client.
    set_project_icon: McpToolAccess.actsAsCaller(setProjectIcon),
  } satisfies McpToolAccess.Handlers<typeof ProjectIconsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(ProjectIconsToolkit, make);
