/**
 * Rows for the project scope picker, which filters the sidebar's thread list
 * to one project.
 *
 * The rows are numbered by position, so row N is reachable with mod+N for the
 * first nine. "All projects" sits last and gets whatever number its position
 * earns: the rule the eye learns is "row N is mod+N", and carving out an
 * exception for the clear row would break it for no gain.
 *
 * Kept pure and separate from the component so the ordering, the numbering and
 * the search terms are testable without rendering a dialog.
 */
import type { ReactNode } from "react";

import {
  enumerateCommandPaletteItems,
  type CommandPaletteActionItem,
} from "../CommandPalette.logic";

export const ALL_PROJECTS_SCOPE_VALUE = "project-scope:all";

/**
 * The four fields a row is built from. Declared here rather than taken as a
 * whole `SidebarProjectSnapshot` so the function's real data dependency is
 * visible, and so a test can build an honest fixture instead of casting one.
 */
export interface ProjectScopeGroup {
  readonly projectKey: string;
  readonly displayName: string;
  readonly workspaceRoot: string;
  readonly memberProjects: ReadonlyArray<{
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
}

export function buildProjectScopeItems<TGroup extends ProjectScopeGroup>(input: {
  groups: ReadonlyArray<TGroup>;
  renderIcon: (group: TGroup) => ReactNode;
  onScope: (projectScopeKey: string | null) => void;
  allProjectsIcon?: ReactNode;
}): CommandPaletteActionItem[] {
  const projectItems = input.groups.map((group): CommandPaletteActionItem => {
    // A logical project can span several environments. Searching only the
    // group's display name would miss the path the user actually remembers.
    const memberTerms = group.memberProjects.flatMap((member) => [
      member.title,
      member.workspaceRoot,
    ]);

    return {
      kind: "action",
      value: `project-scope:${group.projectKey}`,
      searchTerms: [group.displayName, group.workspaceRoot, ...memberTerms],
      title: group.displayName,
      description: group.workspaceRoot,
      icon: input.renderIcon(group),
      run: async () => {
        input.onScope(group.projectKey);
      },
    };
  });

  return enumerateCommandPaletteItems([
    ...projectItems,
    {
      kind: "action",
      value: ALL_PROJECTS_SCOPE_VALUE,
      searchTerms: ["all projects", "every project", "clear filter", "unfilter", "reset"],
      title: "All projects",
      icon: input.allProjectsIcon ?? null,
      run: async () => {
        input.onScope(null);
      },
    },
  ]);
}
