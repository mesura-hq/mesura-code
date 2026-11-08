import {
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconDiscoveryStatus,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  SCRIPT_RUN_COMMAND_PATTERN,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import {
  completeProjectIconDiscovery,
  invalidateProjectIconDiscovery,
  requestProjectIconDiscovery,
  startProjectIconDiscovery,
} from "./projectIconDiscovery.ts";
import type { ProjectRow } from "./ProjectStore.ts";
import {
  isThreadSearchProject,
  THREAD_SEARCH_PROJECT_DELETION_REFUSAL,
} from "./threadSearchProject.ts";

export interface ProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectMetaUpdateCommand {
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly autoPull?: boolean;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  /**
   * Mesura: the root an icon file was inspected or prepared against. The
   * update is rejected when the project moved or was deleted since.
   */
  readonly expectedWorkspaceRoot?: string;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

/**
 * Mesura: the agent icon search. Server-internal: only `ProjectIconDiscovery`
 * dispatches these, through `ProjectService`; no client contract carries them.
 * The request's command id becomes the job token.
 */
export interface ProjectIconDiscoveryRequestCommand {
  readonly type: "project.icon-discovery.request";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectIconDiscoveryStartCommand {
  readonly type: "project.icon-discovery.start";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly jobToken: CommandId;
}

export interface ProjectIconDiscoveryCompleteCommand {
  readonly type: "project.icon-discovery.complete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly jobToken: CommandId;
  readonly generation: number;
  readonly status: ProjectIconDiscoveryStatus;
  readonly path: string | null;
  readonly reason: string;
}

export type ProjectIconDiscoveryCommand =
  | ProjectIconDiscoveryRequestCommand
  | ProjectIconDiscoveryStartCommand
  | ProjectIconDiscoveryCompleteCommand;

export type ProjectCommand =
  | ProjectCreateCommand
  | ProjectMetaUpdateCommand
  | ProjectDeleteCommand
  // Mesura: see ProjectIconDiscoveryCommand.
  | ProjectIconDiscoveryCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  readonly project: ProjectRow | undefined;
  readonly workspaceOwner: ProjectRow | undefined;
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

/** Read state and commit the planned event under the project lock. */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const conflict = requireWorkspaceAvailable(command.workspaceRoot);
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      // Mesura: an icon file prepared against another root must not land.
      if (
        command.expectedWorkspaceRoot !== undefined &&
        project.workspaceRoot !== command.expectedWorkspaceRoot
      ) {
        return invariant(
          `Project '${command.projectId}' moved or was deleted before its icon was saved.`,
        );
      }
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      if (command.scripts !== undefined) {
        // Allow editing or removing persisted invalid script ids, while rejecting new invalid ids.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      // Mesura: a manual icon write or a root change supersedes an icon search.
      const iconDiscovery = invalidateProjectIconDiscovery(
        project,
        {
          suppliesIcon: command.faviconPath !== undefined || command.projectIcon !== undefined,
          workspaceRoot: command.workspaceRoot,
        },
        occurredAt,
      );
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(iconDiscovery === undefined ? {} : { iconDiscovery }),
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          updatedAt: occurredAt,
        },
      });
    }

    // Mesura: each icon search stage is one `project.meta-updated`, so the
    // shell stream already carries it. A stage that no longer applies emits
    // an event that changes nothing, which keeps its receipt accepted.
    case "project.icon-discovery.request":
    case "project.icon-discovery.start":
    case "project.icon-discovery.complete": {
      // Start and complete still reach a deleted project, so a job ends.
      const project = state.project;
      if (project === undefined) return missingProject();
      if (command.type === "project.icon-discovery.request" && project.deletedAt !== null) {
        return missingProject();
      }
      const change =
        command.type === "project.icon-discovery.request"
          ? { iconDiscovery: requestProjectIconDiscovery(project, command.commandId, occurredAt) }
          : command.type === "project.icon-discovery.start"
            ? { iconDiscovery: startProjectIconDiscovery(project, command.jobToken, occurredAt) }
            : completeProjectIconDiscovery(project, command, occurredAt);
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(change?.iconDiscovery === undefined ? {} : { iconDiscovery: change.iconDiscovery }),
          ...(change !== undefined && "faviconPath" in change
            ? { faviconPath: change.faviconPath }
            : {}),
          // A search is not an edit: the project keeps its place in recency order.
          updatedAt: project.updatedAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Mesura: the hidden search project is not the user's to delete (ADR-010).
      if (isThreadSearchProject(command.projectId))
        return invariant(THREAD_SEARCH_PROJECT_DELETION_REFUSAL);
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }
  }
}
