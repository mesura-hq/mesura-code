/**
 * Pure decisions for a project's Luna icon search, called from the decider.
 *
 * The decider is serialized, so comparing the job token, generation, captured
 * root and starting icon fields here is what protects a manual choice: a
 * completion either saves its image together with its outcome in one event, or
 * changes nothing on the project.
 *
 * @module projectIconDiscovery
 */
import {
  ProjectIconOverride,
  type CommandId,
  type OrchestrationProject,
  type ProjectIconDiscoveryState,
  type ProjectIconDiscoveryStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const iconOverridesEqual = Schema.toEquivalence(Schema.NullOr(ProjectIconOverride));

export const isProjectIconDiscoveryActive = (
  state: ProjectIconDiscoveryState | null | undefined,
): boolean => state?.status === "pending" || state?.status === "running";

/**
 * A metadata update that supplies either icon field, or moves the root,
 * advances the generation. That holds even when the values do not change, so a
 * reset from null to null still invalidates a search started before it.
 */
export function invalidateProjectIconDiscovery(
  project: OrchestrationProject,
  change: { readonly suppliesIcon: boolean; readonly workspaceRoot: string | undefined },
  updatedAt: string,
): ProjectIconDiscoveryState | undefined {
  const state = project.iconDiscovery;
  if (!state) return undefined;
  const movesRoot =
    change.workspaceRoot !== undefined && change.workspaceRoot !== project.workspaceRoot;
  if (!change.suppliesIcon && !movesRoot) return undefined;
  return {
    ...state,
    generation: state.generation + 1,
    ...(isProjectIconDiscoveryActive(state)
      ? {
          status: "superseded" as const,
          path: null,
          reason: "The project icon or folder changed during the search.",
        }
      : {}),
    updatedAt,
  };
}

/** Claims a new job, or returns undefined so the request joins the active one. */
export function requestProjectIconDiscovery(
  project: OrchestrationProject,
  jobToken: CommandId,
  updatedAt: string,
): ProjectIconDiscoveryState | undefined {
  if (isProjectIconDiscoveryActive(project.iconDiscovery)) return undefined;
  return {
    generation: (project.iconDiscovery?.generation ?? 0) + 1,
    jobToken,
    workspaceRoot: project.workspaceRoot,
    startingFaviconPath: project.faviconPath ?? null,
    startingProjectIcon: project.projectIcon ?? null,
    status: "pending",
    path: null,
    reason: "Waiting for Luna.",
    updatedAt,
  };
}

export function startProjectIconDiscovery(
  project: OrchestrationProject,
  jobToken: CommandId,
  updatedAt: string,
): ProjectIconDiscoveryState | undefined {
  const state = project.iconDiscovery;
  if (!state || state.jobToken !== jobToken || state.status !== "pending") return undefined;
  return { ...state, status: "running", reason: "The agent is checking local images.", updatedAt };
}

export interface ProjectIconDiscoveryCompletion {
  readonly jobToken: CommandId;
  readonly generation: number;
  readonly status: ProjectIconDiscoveryStatus;
  readonly path: string | null;
  readonly reason: string;
}

/**
 * Ends the active job. A completion for another token, or for a job that is no
 * longer active, changes nothing. A project that changed since the request is
 * recorded as superseded and keeps its icon fields.
 */
export function completeProjectIconDiscovery(
  project: OrchestrationProject,
  completion: ProjectIconDiscoveryCompletion,
  updatedAt: string,
):
  | { readonly iconDiscovery: ProjectIconDiscoveryState; readonly faviconPath?: string }
  | undefined {
  const state = project.iconDiscovery;
  if (!state || !isProjectIconDiscoveryActive(state) || state.jobToken !== completion.jobToken) {
    return undefined;
  }
  const end = (
    status: ProjectIconDiscoveryStatus,
    path: string | null,
    reason: string,
  ): ProjectIconDiscoveryState => ({ ...state, status, path, reason, updatedAt });

  if (completion.status === "interrupted") {
    return { iconDiscovery: end("interrupted", null, completion.reason) };
  }
  const unchanged =
    project.deletedAt === null &&
    completion.generation === state.generation &&
    project.workspaceRoot === state.workspaceRoot &&
    (project.faviconPath ?? null) === state.startingFaviconPath &&
    iconOverridesEqual(project.projectIcon ?? null, state.startingProjectIcon);
  if (!unchanged) {
    return {
      iconDiscovery: end(
        "superseded",
        null,
        "The project icon or folder changed during the search.",
      ),
    };
  }
  if (completion.status === "selected") {
    return completion.path === null
      ? { iconDiscovery: end("failed", null, "Luna returned no image path.") }
      : {
          iconDiscovery: end("selected", completion.path, completion.reason),
          faviconPath: completion.path,
        };
  }
  if (completion.status === "pending" || completion.status === "running") {
    return { iconDiscovery: end("failed", null, "The search ended without an outcome.") };
  }
  return { iconDiscovery: end(completion.status, null, completion.reason) };
}
