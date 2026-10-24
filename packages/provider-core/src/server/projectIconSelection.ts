/**
 * Mesura: the provider-side contract of the Luna project-icon search.
 *
 * A provider instance that can answer the search exposes
 * `ProviderInstance.selectProjectIcon`. The server's project-icon discovery
 * decides when a search may run and builds the request; only the types it
 * shares with drivers live here, because provider-core cannot import the
 * server.
 *
 * @module provider-core/server/projectIconSelection
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
