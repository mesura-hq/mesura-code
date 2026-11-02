import {
  AuthOrchestrationOperateScope,
  describeProjectIconChange,
  type EnvironmentId,
  type ProjectIconEffectiveSource,
  type ProjectIconOverride,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

import { defaultProjectIcon } from "../components/settings/ProjectSettingsPanel.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { Project } from "../types";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useProjects, useServerConfigs } from "../state/entities";
import { readEnvironment } from "../state/environments";
import { projectIconPreviewCommand } from "../state/projectIcons";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export type ProjectGroupUpdate = Partial<{
  title: string;
  faviconPath: string | null;
  projectIcon: ProjectIconOverride | null;
  pinned: boolean;
  archived: boolean;
  /** Mesura: the write fails when the checkout no longer has this root. */
  expectedWorkspaceRoot: string;
}>;

type ProjectGroupMember = Pick<
  SidebarProjectGroupMember,
  "environmentId" | "id" | "environmentLabel"
>;

/**
 * Writes one update to each checkout of a project, one machine at a time, and
 * reports the first failure as a toast. Every machine must be connected first.
 */
export function useProjectGroupUpdate() {
  const serverConfigs = useServerConfigs();
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });

  const updateProjectGroup = async <TMember extends ProjectGroupMember>(
    members: ReadonlyArray<TMember>,
    input: ProjectGroupUpdate | ((member: TMember) => ProjectGroupUpdate),
    failureTitle: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    const denied = checkProjectAccess(members, failureTitle);
    if (denied) return denied;
    const unavailable = members.find((member) => {
      const environment = readEnvironment(member.environmentId);
      return environment?.connection.phase !== "connected" || !environment.serverConfig;
    });
    if (unavailable) {
      return failWith(
        failureTitle,
        `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
      );
    }
    for (const member of members) {
      // Access can be revoked between writes.
      const revoked = checkProjectAccess([member], failureTitle);
      if (revoked) return revoked;
      const result = mapAtomCommandResult(
        await updateProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            ...(typeof input === "function" ? input(member) : input),
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectFailure(
          members.length > 1
            ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
            : failureTitle,
          result,
        );
        return result;
      }
    }
    return AsyncResult.success(undefined);
  };

  /** Older servers drop pin and archive, so their projects do not offer them. */
  const canOrganizeProjectGroup = (members: ReadonlyArray<ProjectGroupMember>) =>
    members.every(
      (member) =>
        serverConfigs.get(member.environmentId)?.environment.capabilities.projectOrganization ===
        true,
    );

  return { updateProjectGroup, canOrganizeProjectGroup };
}

/**
 * One physical project a group edit writes to, as it was when the edit began.
 * A picker captures these when it opens, so a re-render after a member moves
 * cannot point the write at the new root.
 */
export interface ProjectGroupWriteTarget extends Pick<Project, "isScratch"> {
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
    ...(member.isScratch ? { isScratch: member.isScratch } : {}),
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

// Mesura: saving or clearing a group's image, shared by Settings and the icon file dialog.
export function useProjectGroupImageUpdate(group: SidebarProjectSnapshot) {
  const { updateProjectGroup } = useProjectGroupUpdate();
  const previewProjectIcons = useAtomCommand(projectIconPreviewCommand, { reportFailure: false });

  /** What each target displays now, read without starting a search; empty when unreadable. */
  const readEffectiveIcons = async (
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
  };

  /**
   * Saves (or, with null, clears) the group's image and reports what each
   * checkout actually displays. Every write is guarded by the root its target
   * had when the edit began: a path chosen under an old root, or a reset of a
   * deleted project, fails instead of claiming success. Never starts a search.
   */
  const updateProjectImage = async (
    faviconPath: string | null,
    targets: ReadonlyArray<ProjectGroupWriteTarget> = captureProjectGroupWriteTargets(group),
  ): Promise<AtomCommandResult<void, unknown>> => {
      const result = await updateProjectGroup(
        targets,
        (target) => ({
          ...(faviconPath === null
            ? defaultProjectIcon(target)
            : { faviconPath, projectIcon: null }),
          expectedWorkspaceRoot: target.workspaceRoot,
        }),
        "Failed to update project icon",
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
  };

  return { updateProjectImage };
}

/** Pin state for a project group, shared by every list that can pin or unpin a project. */
export function useProjectPin() {
  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();
  const environments = [...new Set(useProjects().map((project) => project.environmentId))].map(
    (environmentId) => ({ environmentId }),
  );
  const operableEnvironmentIds = useEnvironmentsWithScope(
    environments,
    AuthOrchestrationOperateScope,
  );
  type PinnableGroup = {
    readonly memberProjects: ReadonlyArray<ProjectGroupMember>;
    readonly pinned: boolean;
  };
  const canPinProjectGroup = (group: PinnableGroup) =>
    canOrganizeProjectGroup(group.memberProjects) &&
    group.memberProjects.every((member) => operableEnvironmentIds.has(member.environmentId));
  const setProjectGroupPinned = (group: PinnableGroup, pinned: boolean) => {
    void updateProjectGroup(
      group.memberProjects,
      { pinned },
      pinned ? "Failed to pin project" : "Failed to unpin project",
    );
  };
  return {
    canPinProjectGroup,
    setProjectGroupPinned,
    toggleProjectGroupPin: (group: PinnableGroup) => setProjectGroupPinned(group, !group.pinned),
  };
}

/** Reports the first member this connection cannot change, and returns that failure. */
export function checkProjectAccess(
  members: ReadonlyArray<ProjectGroupMember>,
  failureTitle: string,
): AtomCommandResult<void, unknown> | null {
  const denied = members.find(
    (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
  );
  return denied
    ? failWith(
        failureTitle,
        `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
      )
    : null;
}

export function reportProjectFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function failWith(title: string, message: string): AtomCommandResult<void, unknown> {
  const result = AsyncResult.failure<void, Error>(Cause.fail(new Error(message)));
  reportProjectFailure(title, result);
  return result;
}
