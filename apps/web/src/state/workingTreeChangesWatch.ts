import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Fork: per-file git status for the Diff surface's Tree diff, pushed on file or git state changes.
 * Web-only for the same reason as `projectFileWatch`. Five seconds of idle survives a Diff panel
 * remount and releases the server watcher soon after Tree diff closes.
 */
export const workingTreeChangesWatch = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:review:working-tree-changes-watch",
    tag: WS_METHODS.reviewSubscribeWorkingTreeChanges,
    idleTtlMs: 5_000,
  },
);
