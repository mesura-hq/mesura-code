import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

/** Native Codex assigns CODEX_THREAD_ID inside each tool, not at app-server spawn. */
export function codexWorkloadContext(
  environment: Readonly<NodeJS.ProcessEnv>,
  context: { readonly environmentId: EnvironmentId; readonly instanceId: ProviderInstanceId },
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...environment,
    MESURA_ENVIRONMENT_ID: context.environmentId,
    MESURA_PROVIDER_INSTANCE_ID: context.instanceId,
    MESURA_WORKLOAD_IDENTITY_KIND: "codex-thread",
  };
  delete result.MESURA_THREAD_ID;
  delete result.CODEX_THREAD_ID;
  return result;
}
