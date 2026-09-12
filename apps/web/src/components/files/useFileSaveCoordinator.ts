import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";

/** Editing pauses this long before a save goes out. */
export const FILE_SAVE_DEBOUNCE_MS = 500;

export interface FileSaveCoordinatorInput {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

/**
 * The debounced autosave for one file.
 *
 * Lives in its own module because both the editing surface and the rendered
 * markdown surface need it, and the surface cannot import it from the panel
 * that renders the surface.
 *
 * One coordinator per path: disposing it on a file switch flushes a pending
 * edit rather than dropping it, which is what makes the file the user returns
 * to match what they left.
 */
export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveCoordinatorInput): FileSaveCoordinator {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const coordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => onPendingChange(relativePath, pending),
        persist: (nextContents) =>
          writeFile({
            environmentId,
            input: { cwd, relativePath, contents: nextContents },
          }),
        onConfirmed: (confirmedContents) => {
          confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
        },
      }),
    [cwd, environmentId, onPendingChange, relativePath, writeFile],
  );

  useEffect(() => () => coordinator.dispose(), [coordinator]);
  return coordinator;
}
