import type { OverviewModel } from "@symmetria/fm-ui/tree";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef } from "react";

import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";

import { useProjectEntriesQuery } from "../projectFilesQueryState";
import { overviewFoldersFromEntries } from "./overviewModelFromEntries";

const NO_ENTRIES: ReadonlyArray<never> = [];

/**
 * `projects.listEntries`, as the model the Symmetria tree renders.
 *
 * The list refreshes when an agent writes to the workspace, keyed the way the
 * file panel keys its own refresh. `onRefresh` rides on the model's refresh so
 * the tree's Refresh button re-reads the open file too, as the T3 tree's did.
 */
export function useProjectOverviewModel(
  environmentId: EnvironmentId,
  cwd: string,
  workspaceMutationId: string | null,
  onRefresh?: () => void,
): {
  readonly model: OverviewModel;
  readonly error: string | null;
  readonly hasData: boolean;
  readonly truncated: boolean;
} {
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: entriesQuery.refresh,
    resourceKey: `files:${environmentId}:${cwd}`,
  });
  const data = entriesQuery.data;
  const entries = data?.entries ?? NO_ENTRIES;
  const folders = useMemo(() => overviewFoldersFromEntries(cwd, entries), [cwd, entries]);
  const truncated = data?.truncated ?? false;
  const isPending = entriesQuery.isPending;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const queryRefresh = entriesQuery.refresh;
  const refresh = useCallback(() => {
    queryRefresh();
    onRefreshRef.current?.();
  }, [queryRefresh]);
  const model = useMemo<OverviewModel>(
    () => ({
      folders,
      loading: data === null && isPending,
      inspected: entries.length,
      include: refresh,
      refresh,
      refreshing: data !== null && isPending,
      paused: false,
    }),
    [data, entries.length, folders, isPending, refresh],
  );
  return { model, error: entriesQuery.error, hasData: data !== null, truncated };
}
