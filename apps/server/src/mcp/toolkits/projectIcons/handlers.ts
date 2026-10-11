import { CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { prepareProjectIconFile } from "../../../project/ProjectIconFile.ts";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { ProjectIconsToolkit, ProjectIconUpdateError } from "./tools.ts";

export const ProjectIconsToolkitHandlersLive = ProjectIconsToolkit.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const snapshots = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    return {
      set_project_icon: Effect.fn("ProjectIconsToolkit.setProjectIcon")(function* (input) {
        const scope = yield* requireMcpCapability("project-icons");
        const thread = yield* snapshots
          .getThreadShellById(scope.threadId)
          .pipe(
            Effect.mapError(
              () => new ProjectIconUpdateError({ detail: "Could not read this thread." }),
            ),
          );
        if (Option.isNone(thread))
          return yield* new ProjectIconUpdateError({ detail: "This thread no longer exists." });
        const project = yield* snapshots
          .getProjectShellById(thread.value.projectId)
          .pipe(
            Effect.mapError(
              () => new ProjectIconUpdateError({ detail: "Could not read this project." }),
            ),
          );
        if (Option.isNone(project))
          return yield* new ProjectIconUpdateError({ detail: "This project no longer exists." });
        const selected =
          input.imagePath === null
            ? { faviconPath: null, imported: false }
            : yield* Effect.tryPromise({
                try: () =>
                  prepareProjectIconFile({
                    workspaceRoot: project.value.workspaceRoot,
                    workingDirectory: thread.value.worktreePath ?? project.value.workspaceRoot,
                    attachmentsDirectory: config.attachmentsDir,
                    imagePath: input.imagePath!,
                  }),
                catch: (error) =>
                  new ProjectIconUpdateError({
                    detail:
                      error instanceof Error ? error.message : "Could not prepare this image.",
                  }),
              });
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* engine
          .dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(`server:project-icon:${uuid}`),
            projectId: project.value.id,
            faviconPath: selected.faviconPath,
            projectIcon: null,
          })
          .pipe(
            Effect.mapError(
              () => new ProjectIconUpdateError({ detail: "Could not save the project icon." }),
            ),
          );
        return { projectId: project.value.id, ...selected };
      }),
    };
  }),
);
