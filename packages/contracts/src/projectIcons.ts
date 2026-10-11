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

/**
 * Where the displayed project icon comes from, in resolver precedence: a custom
 * icon, then `.mesura.json`, the saved image, `t3.json`, a detected favicon,
 * and finally initials when nothing resolves.
 */
export const ProjectIconEffectiveSource = Schema.Literals([
  "custom",
  "mesura",
  "project",
  "t3",
  "detected",
  "initials",
]);
export type ProjectIconEffectiveSource = typeof ProjectIconEffectiveSource.Type;

const EFFECTIVE_SOURCE_LABELS: Record<ProjectIconEffectiveSource, string> = {
  custom: "the project's custom icon",
  mesura: "the repository icon set in .mesura.json",
  project: "the saved image",
  t3: "the repository icon set in t3.json",
  detected: "the project's own favicon",
  initials: "the project's initials",
};

/**
 * What a manual icon save or reset leaves on screen. The agent tool and the
 * web client both show this, so the two never describe the same state apart.
 */
export function describeProjectIconChange(
  change: "saved" | "reset",
  effectiveSource: ProjectIconEffectiveSource,
): string {
  if (change === "reset") {
    return `Saved project icon cleared; ${EFFECTIVE_SOURCE_LABELS[effectiveSource]} now displays. No Luna search was started.`;
  }
  if (effectiveSource === "project") return "Project icon saved.";
  if (effectiveSource === "mesura" || effectiveSource === "custom") {
    return `Project icon saved, but ${EFFECTIVE_SOURCE_LABELS[effectiveSource]} still displays because it takes precedence over a saved image.`;
  }
  return `Project icon saved, but the image was not found in this checkout, so ${EFFECTIVE_SOURCE_LABELS[effectiveSource]} displays.`;
}

export const ProjectIconDiscoveryPreview = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  candidateCount: Schema.Finite,
  status: Schema.Literals(["ready", "existing", "empty", "failed"]),
  reason: Schema.String,
  // Absent when the project could not be inspected.
  effectiveSource: Schema.optional(ProjectIconEffectiveSource),
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
