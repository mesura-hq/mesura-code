import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  describeProjectIconChange,
  type EnvironmentId,
  type ProjectIconEffectiveSource,
  type ProjectIconOverride,
  type ProjectId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { useCallback, useMemo } from "react";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useEnvironments } from "../state/environments";
import { projectIconPreviewCommand } from "../state/projectIcons";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/**
 * One physical project a group edit writes to, as it was when the edit began.
 * A picker captures these when it opens, so a re-render after a member moves
 * cannot point the write at the new root.
 */
export interface ProjectGroupWriteTarget {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly workspaceRoot: string;
}

export function captureProjectGroupWriteTargets(
  group: SidebarProjectSnapshot,
): ReadonlyArray<ProjectGroupWriteTarget> {
  return group.memberProjects.map((member) => ({
    id: member.id,
    environmentId: member.environmentId,
    environmentLabel: member.environmentLabel ?? null,
    workspaceRoot: member.workspaceRoot,
  }));
}

interface EffectiveIconReport {
  readonly target: ProjectGroupWriteTarget;
  readonly source: ProjectIconEffectiveSource;
}

/**
 * The confirmation for a group image change. Checkouts can disagree, such as
 * one masked by its `.mesura.json` and one showing the saved image; then each
 * checkout is named with what it displays.
 */
function describeGroupImageChange(
  change: "saved" | "reset",
  reports: ReadonlyArray<EffectiveIconReport>,
  displayName: string,
): { readonly type: "success" | "info"; readonly description: string } {
  const sources = new Set(reports.map((report) => report.source));
  const allShowSavedImage = reports.length > 0 && sources.size === 1 && sources.has("project");
  if (reports.length === 0 || (change === "saved" && allShowSavedImage)) {
    return { type: "success", description: displayName };
  }
  const [onlySource] = sources;
  if (sources.size === 1 && onlySource !== undefined) {
    return { type: "info", description: describeProjectIconChange(change, onlySource) };
  }
  return {
    type: "info",
    description: reports
      .map(
        (report) =>
          `${report.target.environmentLabel ?? displayName}: ${describeProjectIconChange(change, report.source)}`,
      )
      .join(" "),
  };
}

export function useProjectGroupUpdate(group: SidebarProjectSnapshot) {
  const { environments } = useEnvironments();
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const previewProjectIcons = useAtomCommand(projectIconPreviewCommand, { reportFailure: false });
  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  /**
   * A connection without the orchestration-operate grant for some member's environment
   * may not edit the group. Reports the first denied environment by name.
   */
  const checkProjectAccess = useCallback(
    (
      members: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly environmentLabel?: string | null | undefined;
      }>,
      failureTitle: string,
    ): AtomCommandResult<void, unknown> | null => {
      const denied = members.find(
        (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
      );
      if (!denied) return null;
      const result = AsyncResult.failure<void, Error>(
        Cause.fail(
          new Error(
            `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
          ),
        ),
      );
      reportFailure(failureTitle, result);
      return result;
    },
    [reportFailure],
  );

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        faviconPath: string | null;
        projectIcon: ProjectIconOverride | null;
      }>,
      failureTitle: string,
      options?: {
        /** The members captured when the edit began; the current group otherwise. */
        readonly targets?: ReadonlyArray<ProjectGroupWriteTarget>;
        /**
         * Each write names its target's captured root, so a member that moved
         * or was deleted since rejects the edit instead of taking it.
         */
        readonly guardWorkspaceRoot?: boolean;
      },
    ): Promise<AtomCommandResult<void, unknown>> => {
      const targets = options?.targets ?? captureProjectGroupWriteTargets(group);
      const denied = checkProjectAccess(targets, failureTitle);
      if (denied) return denied;
      const unavailable = targets.find((target) => {
        const environment = environmentById.get(target.environmentId);
        return environment?.connection.phase !== "connected" || !environment.serverConfig;
      });
      if (unavailable) {
        const error = new Error(
          `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
        );
        const result: AtomCommandResult<void, unknown> = AsyncResult.failure(Cause.fail(error));
        reportFailure(failureTitle, result);
        return result;
      }
      for (const target of targets) {
        const revoked = checkProjectAccess([target], failureTitle);
        if (revoked) return revoked;
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: target.environmentId,
            input: {
              projectId: target.id,
              ...input,
              ...(options?.guardWorkspaceRoot
                ? { expectedWorkspaceRoot: target.workspaceRoot }
                : {}),
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            targets.length > 1
              ? `${failureTitle} on ${target.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [checkProjectAccess, environmentById, group, reportFailure, updateProject],
  );

  /** What each target displays now, read without starting a search; empty when unreadable. */
  const readEffectiveIcons = useCallback(
    async (
      targets: ReadonlyArray<ProjectGroupWriteTarget>,
    ): Promise<ReadonlyArray<EffectiveIconReport>> => {
      const reports: EffectiveIconReport[] = [];
      const environmentIds = new Set(targets.map((target) => target.environmentId));
      for (const environmentId of environmentIds) {
        const inEnvironment = targets.filter((target) => target.environmentId === environmentId);
        const result = await previewProjectIcons({
          environmentId,
          input: { projectIds: inEnvironment.map((target) => target.id) },
        });
        if (result._tag !== "Success") return [];
        for (const preview of result.value) {
          const target = inEnvironment.find((candidate) => candidate.id === preview.projectId);
          if (target && preview.effectiveSource !== undefined) {
            reports.push({ target, source: preview.effectiveSource });
          }
        }
      }
      return reports;
    },
    [previewProjectIcons],
  );

  /**
   * Saves (or, with null, clears) the group's image and reports what each
   * checkout actually displays. Every write is guarded by the root its target
   * had when the edit began: a path chosen under an old root, or a reset of a
   * deleted project, fails instead of claiming success. Never starts a search.
   */
  const updateProjectImage = useCallback(
    async (
      faviconPath: string | null,
      targets: ReadonlyArray<ProjectGroupWriteTarget> = captureProjectGroupWriteTargets(group),
    ): Promise<AtomCommandResult<void, unknown>> => {
      const result = await updateAllMembers(
        { faviconPath, projectIcon: null },
        "Failed to update project icon",
        { targets, guardWorkspaceRoot: true },
      );
      if (result._tag !== "Success") return result;
      const change = faviconPath === null ? "reset" : "saved";
      const confirmation = describeGroupImageChange(
        change,
        await readEffectiveIcons(targets),
        group.displayName,
      );
      toastManager.add({
        type: confirmation.type,
        title: change === "saved" ? "Project icon saved" : "Saved project icon cleared",
        description: confirmation.description,
      });
      return result;
    },
    [group, readEffectiveIcons, updateAllMembers],
  );

  return { updateAllMembers, updateProjectImage, reportFailure, checkProjectAccess };
}
