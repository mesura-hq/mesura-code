import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Web-only: mobile reads files without subscribing, so a shared family would offer it a server
 * watcher it never uses. Five seconds of idle survives the editable surface's per-file remount;
 * the five-minute default would hold the server watcher long after the file closes.
 */
export const projectFileWatch = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:file-watch",
  tag: WS_METHODS.subscribeProjectFile,
  idleTtlMs: 5_000,
});
