/**
 * The sidebar's project groups, in the sidebar's own order.
 *
 * This is a seventh call site of `buildSidebarProjectSnapshots` rather than a
 * refactor of the six that already exist (Sidebar, LegacySidebar,
 * CommandPalette, ProjectSettingsPanel, DraftHeroHeadline and the _chat route).
 * Unifying them would edit six upstream files that this fork merges from every
 * week, which is a recurring cost paid for tidiness upstream has not asked for.
 * The shared logic is already extracted into `buildSidebarProjectSnapshots`;
 * only the hook wiring repeats, and it is copied from DraftHeroHeadline.
 *
 * The order matters: the scope picker numbers its rows by position, so a
 * different order here would mean mod+2 opened a different project in the
 * picker than the second row of the sidebar's own menu.
 */
import { useMemo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { sortLogicalProjectsForSidebar } from "../components/Sidebar.logic";

export function useProjectScopeGroups(): SidebarProjectSnapshot[] {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );

  return useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
}
