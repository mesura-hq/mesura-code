import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const issueList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mesura:issues:list",
  tag: WS_METHODS.issuesList,
  staleTimeMs: 30_000,
});

export const issueDetail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mesura:issues:detail",
  tag: WS_METHODS.issuesDetail,
  staleTimeMs: 30_000,
});
