import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ServerSettings } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { isResumeCompactionOffered } from "./resumeCompactionSetting";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const CLAUDE_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const CLAUDE_CUSTOM_INSTANCE_ID = ProviderInstanceId.make("claude_work");

function claudeInstance(config: Record<string, unknown>) {
  return { driver: ProviderDriverKind.make("claudeAgent"), config };
}

describe("isResumeCompactionOffered", () => {
  it("is on by default", () => {
    expect(isResumeCompactionOffered(decodeServerSettings({}), null)).toBe(true);
    expect(isResumeCompactionOffered(decodeServerSettings({}), CLAUDE_CUSTOM_INSTANCE_ID)).toBe(
      true,
    );
  });

  it("reads the default instance from the legacy providers bucket", () => {
    const settings = decodeServerSettings({
      providers: { claudeAgent: { offerResumeCompaction: false } },
    });
    expect(isResumeCompactionOffered(settings, null)).toBe(false);
    expect(isResumeCompactionOffered(settings, CLAUDE_DEFAULT_INSTANCE_ID)).toBe(false);
    expect(isResumeCompactionOffered(settings, CLAUDE_CUSTOM_INSTANCE_ID)).toBe(true);
  });

  it("prefers the instance's own config over the legacy bucket", () => {
    const settings = decodeServerSettings({
      providers: { claudeAgent: { offerResumeCompaction: false } },
      providerInstances: {
        claudeAgent: claudeInstance({}),
        claude_work: claudeInstance({ offerResumeCompaction: false }),
      },
    });
    expect(isResumeCompactionOffered(settings, CLAUDE_DEFAULT_INSTANCE_ID)).toBe(true);
    expect(isResumeCompactionOffered(settings, CLAUDE_CUSTOM_INSTANCE_ID)).toBe(false);
  });
});
