import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { codexWorkloadContext } from "./codexWorkloadContext.ts";

it("F2 V12 Codex context is immutable and leaves credentials and native thread identity independent", () => {
  const environment = Object.freeze({
    PATH: "/synthetic/bin",
    CODEX_HOME: "/synthetic/shadow",
    ACCESS_TOKEN: "synthetic-token",
    MESURA_ENVIRONMENT_ID: "spoof",
    MESURA_PROVIDER_INSTANCE_ID: "spoof",
    MESURA_WORKLOAD_IDENTITY_KIND: "spoof",
    MESURA_THREAD_ID: "old-app-id",
    CODEX_THREAD_ID: "old-native-id",
  });
  const result = codexWorkloadContext(environment, {
    environmentId: EnvironmentId.make("authoritative-environment"),
    instanceId: ProviderInstanceId.make("authoritative-instance"),
  });
  expect(result).toEqual({
    PATH: "/synthetic/bin",
    CODEX_HOME: "/synthetic/shadow",
    ACCESS_TOKEN: "synthetic-token",
    MESURA_ENVIRONMENT_ID: "authoritative-environment",
    MESURA_PROVIDER_INSTANCE_ID: "authoritative-instance",
    MESURA_WORKLOAD_IDENTITY_KIND: "codex-thread",
  });
  expect(environment.CODEX_THREAD_ID).toBe("old-native-id");
  expect(environment.MESURA_THREAD_ID).toBe("old-app-id");
});
