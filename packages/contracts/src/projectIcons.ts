import * as Schema from "effect/Schema";
import { CommandId, NonNegativeInt, ProjectId } from "./baseSchemas.ts";

export class ProjectIconDiscoveryError extends Schema.TaggedError<ProjectIconDiscoveryError>()(
  "ProjectIconDiscoveryError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProjectIconDiscoveryPreview = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  candidateCount: Schema.Finite,
  status: Schema.Literals(["ready", "existing", "empty", "failed"]),
  reason: Schema.String,
});
export type ProjectIconDiscoveryPreview = typeof ProjectIconDiscoveryPreview.Type;

export const ProjectIconDiscoverInput = Schema.Struct({
  projectId: ProjectId,
  // The client mints it once per deliberate search, so a transport retry of the
  // same request joins the job it already started instead of starting another.
  requestId: CommandId,
});
export type ProjectIconDiscoverInput = typeof ProjectIconDiscoverInput.Type;

/**
 * The job the request started or joined. Its outcome arrives on the project.
 * A later generation under another token means a newer change or search
 * replaced this job.
 */
export const ProjectIconDiscoveryAccepted = Schema.Struct({
  projectId: ProjectId,
  jobToken: CommandId,
  generation: NonNegativeInt,
});
export type ProjectIconDiscoveryAccepted = typeof ProjectIconDiscoveryAccepted.Type;
