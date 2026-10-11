import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Mesura: read-only inspection of project icons; never starts a search. */
export const projectIconPreviewCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "project-icons:preview",
  tag: WS_METHODS.projectIconsPreview,
});

/** Mesura: starts one explicit Luna search for one project. */
export const projectIconDiscoverCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "project-icons:discover",
  tag: WS_METHODS.projectIconsDiscover,
});
