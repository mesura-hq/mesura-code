import type { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  changeFileSaveSession,
  flushFileSaveSession,
  useFileSaveSession,
  type FileSaveTarget,
  type FilePendingListener,
} from "./fileSaveSessions";

export interface FileSaveCoordinatorInput extends FileSaveTarget {
  onPendingChange: FilePendingListener;
}

/** Monaco, Neovim, and rendered Markdown share one ordered write queue per file. */
export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveCoordinatorInput): Pick<FileSaveCoordinator, "change" | "flush"> {
  useFileSaveSession({ environmentId, cwd, relativePath }, onPendingChange);
  const target = { environmentId, cwd, relativePath };
  return {
    change: (contents: string) => changeFileSaveSession(target, contents),
    flush: () => flushFileSaveSession(target),
  };
}
