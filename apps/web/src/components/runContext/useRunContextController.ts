import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { subscribePickerAction } from "../../lib/pickerActionBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
} from "../BranchToolbar.logic";
import type { RunContextWorkspaceOption } from "./RunContextDrawer";
import {
  resolveCycledEnvironmentId,
  resolveInitialRunContextTab,
  resolveNavigableRunContextTabs,
  resolveRunContextHosts,
  resolveRunContextTabRequest,
  resolveToggledEnvMode,
  type RunContextTab,
  type RunContextTabAvailabilityMap,
} from "./runContextDrawer.logic";

export interface RunContextControllerInput {
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  envLocked: boolean;
  /** Only a new-thread draft can move to another machine. */
  isDraft: boolean;
  envModeLocked: boolean;
  showGitControls: boolean;
  autoEnvironmentLabel: string | undefined;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode, options?: { focusComposer?: boolean }) => void;
  onComposerFocusRequest: (() => void) | undefined;
}

/**
 * Owns the run context drawer for one branch toolbar: whether it is open,
 * which tab has the keyboard, and the two quick toggles that change the draft
 * without opening it.
 */
export function useRunContextController(input: RunContextControllerInput) {
  const {
    environmentId,
    availableEnvironments,
    envLocked,
    isDraft,
    envModeLocked,
    showGitControls,
    autoEnvironmentLabel,
    onEnvironmentChange,
    effectiveEnvMode,
    activeWorktreePath,
    onEnvModeChange,
    onComposerFocusRequest,
  } = input;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<RunContextTab | null>(null);

  // Unreachable machines leave the list and the cycle, the current one too;
  // the current one stays as the Host tab's summary.
  const hosts = useMemo(
    () => resolveRunContextHosts(availableEnvironments ?? []),
    [availableEnvironments],
  );
  const currentHost =
    availableEnvironments?.find((environment) => environment.environmentId === environmentId) ??
    null;
  const canMoveHost = hosts.some((environment) => environment.environmentId !== environmentId);
  const availability = useMemo<RunContextTabAvailabilityMap>(
    () => ({
      // Host is always shown, so the three tabs never move: with one machine,
      // or once the thread has started, it is a locked summary.
      host: {
        visible: true,
        editable: canMoveHost && isDraft && !envLocked && onEnvironmentChange !== undefined,
      },
      workspace: { visible: showGitControls, editable: showGitControls && !envModeLocked },
      branch: { visible: showGitControls, editable: showGitControls },
    }),
    [canMoveHost, envLocked, envModeLocked, isDraft, onEnvironmentChange, showGitControls],
  );
  const navigableTabs = useMemo(() => resolveNavigableRunContextTabs(availability), [availability]);

  const open = useCallback(
    (requestedTab: RunContextTab | null) => {
      setActiveTab(resolveInitialRunContextTab(navigableTabs, requestedTab));
      setDrawerOpen(true);
    },
    [navigableTabs],
  );
  const close = useCallback(
    (options: { focusComposer: boolean }) => {
      setDrawerOpen(false);
      setActiveTab(null);
      if (options.focusComposer) onComposerFocusRequest?.();
    },
    [onComposerFocusRequest],
  );

  const cycleMachine = useCallback(() => {
    if (!availability.host.editable || !onEnvironmentChange) return;
    const nextEnvironmentId = resolveCycledEnvironmentId({
      environmentIds: hosts.map((environment) => environment.environmentId),
      currentEnvironmentId: environmentId,
      automatic: autoEnvironmentLabel !== undefined,
      delta: 1,
    });
    if (nextEnvironmentId !== null) onEnvironmentChange(nextEnvironmentId);
  }, [autoEnvironmentLabel, availability.host.editable, environmentId, hosts, onEnvironmentChange]);

  const toggleWorkspace = useCallback(() => {
    if (!availability.workspace.editable) return;
    onEnvModeChange(resolveToggledEnvMode(effectiveEnvMode), { focusComposer: !drawerOpen });
  }, [availability.workspace.editable, drawerOpen, effectiveEnvMode, onEnvModeChange]);

  // Window listeners are cheap, so these resubscribe with the handlers rather
  // than reading them through a ref during render.
  useEffect(() => {
    const openOrClose = (tab: RunContextTab | null) => {
      const request = resolveRunContextTabRequest({
        drawerOpen,
        activeTab,
        requestedTab: tab,
        navigableTabs,
      });
      if (request.kind === "open") open(request.tab);
      else if (request.kind === "switch") setActiveTab(request.tab);
      else close({ focusComposer: true });
    };
    const unsubscribers = [
      subscribePickerAction("runContext.toggle", () => openOrClose(null)),
      // The old picker commands land on their tab in the drawer.
      subscribePickerAction("workspace", () => openOrClose("workspace")),
      subscribePickerAction("branch", () => openOrClose("branch")),
      subscribePickerAction("runContext.cycleMachine", cycleMachine),
      subscribePickerAction("runContext.toggleWorkspace", toggleWorkspace),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [activeTab, close, cycleMachine, drawerOpen, navigableTabs, open, toggleWorkspace]);

  // Two choices, on purpose: the previous worktree stays on its own shortcut
  // (composer.previousWorktree), so the list never changes length under the
  // keyboard. "Current checkout" reads "Current worktree" while the draft
  // points at an existing worktree, because that is where the turn runs.
  const workspaceOptions = useMemo<RunContextWorkspaceOption[]>(
    () => [
      {
        value: "local",
        label: resolveCurrentWorkspaceLabel(activeWorktreePath),
        Icon: activeWorktreePath ? FolderGitIcon : FolderIcon,
      },
      { value: "worktree", label: resolveEnvModeLabel("worktree"), Icon: FolderGit2Icon },
    ],
    [activeWorktreePath],
  );
  const onWorkspaceSelect = useCallback(
    (value: string) => onEnvModeChange(value as EnvMode, { focusComposer: false }),
    [onEnvModeChange],
  );

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  return {
    drawerOpen,
    activeTab,
    setActiveTab,
    open,
    close,
    drawerProps: {
      activeTab,
      onActiveTabChange: setActiveTab,
      onClose: close,
      availability,
      environments: hosts,
      currentHost,
      environmentId,
      autoEnvironmentLabel,
      onEnvironmentChange,
      workspaceOptions,
      selectedWorkspace: effectiveEnvMode as string,
      lockedWorkspaceLabel: resolveLockedWorkspaceLabel(activeWorktreePath),
      onWorkspaceSelect,
      cycleMachineShortcut: shortcutLabelForCommand(keybindings, "runContext.cycleMachine"),
      toggleWorkspaceShortcut: shortcutLabelForCommand(keybindings, "runContext.toggleWorkspace"),
    },
  };
}
