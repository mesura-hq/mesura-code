/**
 * Mesura: provider-side types of the Luna project-icon search, exposed through
 * `ProviderInstance.selectProjectIcon`. The server decides when a search runs; only shared types live
 * here, because provider-core cannot import the server.
 */
import type { OrchestrationProjectShell } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ProjectIconSelection = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
export type ProjectIconSelection = typeof ProjectIconSelection.Type;

/** One local image the search may choose. */
interface ProjectIconCandidate {
  readonly path: string;
  readonly bytes: number;
}

export interface ProjectIconSelectionInput {
  readonly project: Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">;
  readonly candidates: ReadonlyArray<ProjectIconCandidate>;
}

/** No configured instance can run the search. Reported before any model work. */
export class ProjectIconSelectionUnavailable extends Schema.TaggedError<ProjectIconSelectionUnavailable>()(
  "ProjectIconSelectionUnavailable",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
