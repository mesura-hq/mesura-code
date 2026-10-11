import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { useProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { ProjectFaviconPickerDialog } from "../settings/ProjectFaviconPickerDialog";
import { toastManager } from "../ui/toast";

// The picker outlives the command palette that closes when its action runs.
const projectIconDialogAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);

export function openProjectIconFileDialog(projectKey: string): void {
  appAtomRegistry.set(projectIconDialogAtom, projectKey);
}

export function ProjectIconFileDialogHost() {
  const projectKey = useAtomValue(projectIconDialogAtom);
  const groups = useSettingsProjectGroups();
  const group = groups.find((candidate) => candidate.projectKey === projectKey);
  return group ? <ProjectIconFileDialog key={projectKey} group={group} /> : null;
}

function ProjectIconFileDialog({ group }: { group: SidebarProjectSnapshot }) {
  const { updateAllMembers } = useProjectGroupUpdate(group);
  return (
    <ProjectFaviconPickerDialog
      cwd={group.workspaceRoot}
      environmentId={group.environmentId}
      projectName={group.displayName}
      open
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(projectIconDialogAtom, null);
      }}
      onSelect={(path) => {
        void updateAllMembers(
          { faviconPath: path, projectIcon: null },
          "Failed to update project icon",
        ).then((result) => {
          if (result._tag === "Success")
            toastManager.add({
              type: "success",
              title: "Project icon updated",
              description: group.displayName,
            });
        });
      }}
    />
  );
}
