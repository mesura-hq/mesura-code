import { FolderGit2Icon, FolderGitIcon, FolderIcon, HistoryIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { subscribePickerAction } from "../lib/pickerActionBus";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  envModeLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envModeLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Gated on the same condition as the early return below: while the workspace
  // is locked this control renders as plain text with no trigger, and a press
  // that flipped the state anyway would open the menu by itself the moment a
  // new thread made the control editable again.
  useEffect(() => {
    if (envModeLocked) {
      setIsOpen(false);
      return;
    }
    return subscribePickerAction("workspace", () => {
      setIsOpen((open) => !open);
    });
  }, [envModeLocked]);
  const composerFloatingLayerProps = useComposerMenuProps();
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
      ...(showPreviousWorktree && previousWorktreeLabel
        ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
        : []),
    ],
    [activeWorktreePath, previousWorktreeLabel, showPreviousWorktree],
  );

  if (envModeLocked) {
    return (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-[calc(--spacing(2)-1px)] font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon className="size-3 shrink-0" />
        ) : (
          <FolderIcon className="size-3 shrink-0" />
        )}
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
          >
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </span>
        </span>
      </span>
    );
  }

  return (
    <Select
      modal={false}
      open={isOpen}
      onOpenChange={setIsOpen}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 shrink font-normal text-xs!"
        aria-label="Workspace"
        data-composer-shortcut="composer.workspace"
        data-composer-context-control
      >
        {effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
          >
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              {activeWorktreePath ? (
                <FolderGitIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              {resolveCurrentWorkspaceLabel(activeWorktreePath)}
            </span>
          </SelectItem>
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <span className="inline-flex items-center gap-1.5">
                <HistoryIcon className="size-3" />
                {previousWorktreeLabel}
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
