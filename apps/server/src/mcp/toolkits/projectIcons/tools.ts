import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class ProjectIconUpdateError extends Schema.TaggedError<ProjectIconUpdateError>()(
  "ProjectIconUpdateError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProjectIconsToolkit = Toolkit.make(
  Tool.make("set_project_icon", {
    description:
      "Set this thread's project icon when the user asks. Pass an image path relative to the thread's working directory or an absolute path. Existing project images remain in place. Images from thread attachments or a worktree are copied into the project's .mesura/project-icons directory. Supports SVG, PNG, JPEG, WebP, GIF, AVIF, and ICO up to 2 MiB. The choice replaces the previous icon and automatic discovery preserves it. Pass null to clear the saved icon and restore repository/default detection. Reset never runs Luna. Do not call without a user request.",
    parameters: Schema.Struct({ imagePath: Schema.NullOr(TrimmedNonEmptyString) }),
    success: Schema.Struct({
      projectId: Schema.String,
      faviconPath: Schema.NullOr(Schema.String),
      imported: Schema.Boolean,
    }),
    failure: Schema.Union([McpCapabilityUnavailableError, ProjectIconUpdateError]),
    dependencies: [
      McpInvocationContext,
      ServerConfig,
      OrchestrationEngineService,
      ProjectionSnapshotQuery,
    ],
  })
    .annotate(Tool.Title, "Set project icon")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);
