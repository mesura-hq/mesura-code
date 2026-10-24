import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ProjectIconEffectiveSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectFaviconResolver } from "../../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

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
      "Set this thread's project icon when the user asks. Pass an image path relative to the thread's working directory, or an absolute path. An image already inside the project is saved in place. An image from this thread's worktree, or one attached to this thread's own messages, is copied into the project's .mesura/project-icons directory. Supports SVG, PNG, JPEG, WebP, GIF, AVIF, and ICO up to 2 MiB. Pass null to clear the saved icon: the project returns to its repository or default icon, and no agent search starts. The result names the icon that actually displays; a repository icon set in .mesura.json takes precedence over a saved image. Do not call without a user request.",
    parameters: Schema.Struct({ imagePath: Schema.NullOr(TrimmedNonEmptyString) }),
    success: Schema.Struct({
      projectId: Schema.String,
      faviconPath: Schema.NullOr(Schema.String),
      imported: Schema.Boolean,
      effectiveSource: ProjectIconEffectiveSource,
      message: Schema.String,
    }),
    // `OrchestratorMcpFailure` is the access gate's refusal (`McpToolAccess`).
    failure: Schema.Union([
      McpCapabilityUnavailableError,
      ProjectIconUpdateError,
      OrchestratorMcpFailure,
    ]),
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
      ProjectService.ProjectService,
      ServerConfig.ServerConfig,
      ProjectFaviconResolver,
    ],
  })
    .annotate(Tool.Title, "Set project icon")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);
