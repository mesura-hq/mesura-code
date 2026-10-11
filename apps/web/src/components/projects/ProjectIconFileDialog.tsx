import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useState } from "react";

import {
  captureProjectGroupWriteTargets,
  useProjectGroupUpdate,
} from "../../hooks/useProjectGroupUpdate";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { ProjectFaviconPickerDialog } from "../settings/ProjectFaviconPickerDialog";

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
  const { updateProjectImage } = useProjectGroupUpdate(group);
  // What the picker browses and what the choice is written to are fixed when
  // it opens; the group can change while the user browses.
  const [opened] = useState(() => ({
    cwd: group.workspaceRoot,
    environmentId: group.environmentId,
    targets: captureProjectGroupWriteTargets(group),
  }));
  return (
    <ProjectFaviconPickerDialog
      cwd={opened.cwd}
      environmentId={opened.environmentId}
      projectName={group.displayName}
      open
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(projectIconDialogAtom, null);
      }}
      onSelect={(path) => void updateProjectImage(path, opened.targets)}
    />
  );
}
