import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";

import { hiddenIdleCompactionFields } from "./idleCompactionFields";
import { providerClients } from "./providerDriverMeta";
import { deriveProviderSettingsFields } from "./ProviderSettingsForm";

const fieldKeys = (driver: string, enabled: boolean) => {
  const definition = providerClients.get(ProviderDriverKind.make(driver));
  expect(definition).toBeDefined();
  return deriveProviderSettingsFields(
    definition!,
    undefined,
    hiddenIdleCompactionFields({ ...DEFAULT_SERVER_SETTINGS, idleCompactionEnabled: enabled }),
  ).map((field) => field.key);
};

describe("hiddenIdleCompactionFields", () => {
  it("hides the Claude compaction fields while idle compaction is off", () => {
    expect(fieldKeys("claudeAgent", false)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "launchArgs",
    ]);
  });

  it("shows them once idle compaction is on", () => {
    expect(fieldKeys("claudeAgent", true)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "offerResumeCompaction",
      "idleCompaction",
      "launchArgs",
    ]);
  });

  it("leaves other providers alone", () => {
    expect(fieldKeys("codex", false)).toEqual(fieldKeys("codex", true));
  });
});
