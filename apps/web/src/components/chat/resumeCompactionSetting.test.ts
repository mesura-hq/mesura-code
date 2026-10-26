import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ServerSettings } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { isResumeCompactionOffered, isResumeCompactionSuggested } from "./resumeCompactionSetting";

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

  it("reads each Claude instance's own config", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        claudeAgent: claudeInstance({}),
        claude_work: claudeInstance({ offerResumeCompaction: false }),
      },
    });
    expect(isResumeCompactionOffered(settings, CLAUDE_DEFAULT_INSTANCE_ID)).toBe(true);
    expect(isResumeCompactionOffered(settings, CLAUDE_CUSTOM_INSTANCE_ID)).toBe(false);
  });
});

describe("isResumeCompactionSuggested", () => {
  it("stays quiet on a fresh home and on a stored mode never switched on", () => {
    expect(isResumeCompactionSuggested(decodeServerSettings({}), null)).toBe(false);
    const stored = decodeServerSettings({ idleCompaction: "onReturn" });
    expect(isResumeCompactionSuggested(stored, null)).toBe(false);
    expect(isResumeCompactionSuggested(stored, CLAUDE_CUSTOM_INSTANCE_ID)).toBe(false);
  });

  it("suggests once switched on, except where a Claude instance turns resume offers off", () => {
    const settings = decodeServerSettings({
      idleCompaction: "onReturn",
      idleCompactionEnabled: true,
      providerInstances: {
        claudeAgent: claudeInstance({ offerResumeCompaction: false }),
        claude_work: claudeInstance({}),
        claude_never: claudeInstance({ idleCompaction: "off" }),
      },
    });
    expect(isResumeCompactionSuggested(settings, null)).toBe(false);
    expect(isResumeCompactionSuggested(settings, CLAUDE_DEFAULT_INSTANCE_ID)).toBe(false);
    expect(isResumeCompactionSuggested(settings, CLAUDE_CUSTOM_INSTANCE_ID)).toBe(true);
    expect(isResumeCompactionSuggested(settings, ProviderInstanceId.make("claude_never"))).toBe(
      false,
    );
  });
});
