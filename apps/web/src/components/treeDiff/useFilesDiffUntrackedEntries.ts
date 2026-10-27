import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import type { DiffFileTreeEntry } from "../diffs/diffFileTree.logic";
import { markUntrackedTreeEntries } from "./treeDiff.logic";

/**
 * Fork addition: Files diff's tree entries with untracked files marked. The server adds them to
 * the working-tree patch with `--intent-to-add`, so they look like staged additions; the working
 * tree's status tells them apart. It is re-read once per new patch result that has a new file.
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
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: re-reads the status when a new patch result arrives from the server
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
