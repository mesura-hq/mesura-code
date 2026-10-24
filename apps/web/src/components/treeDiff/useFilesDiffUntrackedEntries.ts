import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import type { DiffFileTreeEntry } from "../diffs/diffFileTree.logic";
import { markUntrackedTreeEntries } from "./treeDiff.logic";

/**
 * Fork addition: Files diff's tree entries with untracked files marked as such.
 *
 * The server adds untracked files to the working-tree patch with
 * `--intent-to-add`, so the patch reports them as new files, the same as a
 * staged addition. The working tree's own status says which of them git does
 * not track yet. Only Files diff needs this: in a branch range or a turn, a new
 * file is an added one.
 *
 * One read per working-tree patch that has a new file: `preview` is the patch result the entries
 * came from, and a new one (a refresh, focus, a finished tool call) re-reads
 * the status beside it, at the cwd the server accepted for that patch.
 */
export function useFilesDiffUntrackedEntries(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly preview: { readonly cwd: string } | null;
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
}): ReadonlyArray<DiffFileTreeEntry> {
  const { environmentId, preview, entries } = input;
  // Without a new file in the patch there is nothing to tell apart, and no read.
  const enabled = input.enabled && entries.some((entry) => entry.status === "added");
  const changes = useEnvironmentQuery(
    enabled && environmentId !== null && preview !== null
      ? reviewEnvironment.workingTreeChanges({ environmentId, input: { cwd: preview.cwd } })
      : null,
  );
  const refreshChanges = changes.refresh;
  const lastPreviewRef = useRef(preview);
  useEffect(() => {
    const previous = lastPreviewRef.current;
    lastPreviewRef.current = preview;
    // The first patch is read together with the status; only a later one re-reads it.
    if (enabled && previous !== null && preview !== null && previous !== preview) {
      refreshChanges();
    }
  }, [enabled, preview, refreshChanges]);

  const files = enabled ? (changes.data?.files ?? null) : null;
  return useMemo(
    () => (files === null ? entries : markUntrackedTreeEntries(entries, files)),
    [entries, files],
  );
}
