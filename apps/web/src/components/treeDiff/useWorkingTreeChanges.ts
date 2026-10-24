import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GitWorkingTreeChangesResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { serverEnvironment } from "../../state/server";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { workingTreeChangesWatch } from "../../state/workingTreeChangesWatch";
import {
  formatGitChangeDecoration,
  gitChangeRows,
  gitChangeTitle,
  gitChangeTreeEntries,
  isPathInsideRepository,
  isWorkspaceRootRefusal,
  summarizeGitChanges,
  type GitChangeRow,
} from "./treeDiff.logic";

/**
 * Opens a changed file in its own tab, as the IDE opened it in the editor, with
 * the explorer hidden on that tab: Tree diff stays one tab away and already
 * lists the files. A file deleted from the working tree has nothing to open,
 * and a file outside the thread's cwd has no path in its file tabs.
 */
export function openGitChangeFile(
  threadRef: ScopedThreadRef,
  rowsByPath: ReadonlyMap<string, GitChangeRow>,
  path: string,
): void {
  const row = rowsByPath.get(path);
  if (!row || row.workspacePath === null || row.change.worktree === "D") return;
  useRightPanelStore
    .getState()
    .openFile(threadRef, row.workspacePath, undefined, { explorerHidden: true });
}

/**
 * A refresh's outcome, shown until the stream emits something newer than it
 * saw: the forced read's answer, or why it failed.
 */
type RefreshOutcome =
  | {
      readonly streamDataAtRefresh: GitWorkingTreeChangesResult | null;
      readonly data: GitWorkingTreeChangesResult;
      readonly error: null;
    }
  | {
      readonly streamDataAtRefresh: GitWorkingTreeChangesResult | null;
      readonly data: null;
      readonly error: string;
    };

/**
 * The working tree's changed files for one cwd, live: the server re-reads git
 * whenever a file or git's own state changes and pushes the result while this
 * hook is mounted. `refresh` forces one re-read through the one-shot request,
 * for the rare change the server's watcher cannot see.
 */
export function useWorkingTreeChanges(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}) {
  const { environmentId, cwd } = input;
  const enabled = environmentId !== null && cwd !== null;
  const primaryStream = useEnvironmentQuery(
    enabled ? workingTreeChangesWatch({ environmentId, input: { cwd } }) : null,
  );
  // The Diff surface's fallback, for the same server check: a server whose
  // workspace root sits below the repository (a dev server runs from
  // apps/server) refuses a cwd above it, so ask again at the server's own cwd.
  // Git answers for the whole repository from either place.
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const fallbackCwd =
    isWorkspaceRootRefusal(primaryStream.error) &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== cwd
      ? serverConfig.cwd
      : null;
  const fallbackStream = useEnvironmentQuery(
    enabled && fallbackCwd !== null
      ? workingTreeChangesWatch({ environmentId, input: { cwd: fallbackCwd } })
      : null,
  );
  // The fallback answer is for the server's repository. A thread in another
  // repository (a worktree outside this server's workspace) must not be shown
  // that repository's changes as if they were its own.
  const fallbackIsForeign =
    fallbackCwd !== null &&
    fallbackStream.data !== null &&
    cwd !== null &&
    !isPathInsideRepository(fallbackStream.data.repositoryRoot, cwd);
  const useFallback = fallbackCwd !== null && !fallbackIsForeign;
  const stream = useFallback ? fallbackStream : primaryStream;
  const streamCwd = useFallback ? fallbackCwd : cwd;

  const runOneShot = useAtomQueryRunner(reviewEnvironment.workingTreeChanges, {
    refresh: true,
    reportFailure: false,
  });
  const [refreshOutcome, setRefreshOutcome] = useState<RefreshOutcome | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const streamData = stream.data;
  const refresh = useCallback(() => {
    if (environmentId === null || streamCwd === null) return;
    setIsRefreshing(true);
    void runOneShot({ environmentId, input: { cwd: streamCwd } }).then((result) => {
      setIsRefreshing(false);
      if (result._tag === "Success") {
        setRefreshOutcome({ streamDataAtRefresh: streamData, data: result.value, error: null });
      } else if (!isAtomCommandInterrupted(result)) {
        setRefreshOutcome({
          streamDataAtRefresh: streamData,
          data: null,
          error: formatEnvironmentQueryError(result.cause),
        });
      }
    });
  }, [environmentId, runOneShot, streamCwd, streamData]);

  // A newer stream value supersedes the refresh, whether it succeeded or failed.
  const currentRefresh =
    refreshOutcome !== null && refreshOutcome.streamDataAtRefresh === streamData
      ? refreshOutcome
      : null;
  const data = currentRefresh?.data ?? streamData;
  const rows = useMemo(
    () => (data && cwd !== null ? gitChangeRows(data.files, data.repositoryRoot, cwd) : []),
    [cwd, data],
  );
  const summary = useMemo(() => summarizeGitChanges(data?.files ?? []), [data]);
  const rowsByPath = useMemo(() => new Map(rows.map((row) => [row.path, row])), [rows]);
  const treeEntries = useMemo(() => gitChangeTreeEntries(rows), [rows]);
  // The tree's row accessory: line counts, with the full status as its title.
  const renderFileDecoration = useCallback(
    (path: string) => {
      const row = rowsByPath.get(path);
      if (!row) return null;
      const text = formatGitChangeDecoration(row.change);
      return text === null ? null : { text, title: gitChangeTitle(row.change) };
    },
    [rowsByPath],
  );

  return {
    rows,
    rowsByPath,
    treeEntries,
    renderFileDecoration,
    summary,
    refName: data?.refName ?? null,
    isRepo: data?.isRepo ?? true,
    truncated: data?.truncated ?? false,
    isPending: isRefreshing,
    hasLoaded: data !== null,
    error: stream.error,
    /** Why the last refresh failed, while no newer result has arrived. */
    refreshError: currentRefresh?.error ?? null,
    refresh,
  };
}
