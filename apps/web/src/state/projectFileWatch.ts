import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Watches one project file for the web file panel.
 *
 * Deliberately here rather than in the shared client package: mobile reads
 * files without subscribing, and a family defined in the shared package would
 * offer a server watcher to a client that has no use for one.
 *
 * Five seconds of idle survives the per-file remount of the editable surface
 * without holding a server watcher open for minutes after the file closes. The
 * default is five minutes, which would do exactly that.
 */
export const projectFileWatch = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:file-watch",
  tag: WS_METHODS.subscribeProjectFile,
  idleTtlMs: 5_000,
});
