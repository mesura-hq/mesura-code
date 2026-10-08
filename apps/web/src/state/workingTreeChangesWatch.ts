import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Fork addition: the working tree's per-file git status, pushed by the server
 * whenever a file or git's own state changes, for the Diff surface's Tree diff.
 *
 * Here rather than in the shared client package for the same reason as
 * `projectFileWatch`: only a client with Tree diff on screen should hold a
 * server watcher. Five seconds of idle survives a remount of the Diff panel
 * and releases the watcher soon after Tree diff closes.
 */
export const workingTreeChangesWatch = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:review:working-tree-changes-watch",
    tag: WS_METHODS.reviewSubscribeWorkingTreeChanges,
    idleTtlMs: 5_000,
  },
);
