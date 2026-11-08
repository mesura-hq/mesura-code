import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import { resolveIdleCompaction, ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CLAUDE_WORK = ProviderInstanceId.make("claude_work");

describe("idleCompactionEnabled", () => {
  it("is off for a fresh home", () => {
    const settings = decodeServerSettings({});
    expect(settings.idleCompactionEnabled).toBe(false);
    expect(resolveIdleCompaction(settings, CLAUDE)).toBe("off");
  });

  it("keeps every stored mode out of effect while it is off", () => {
    for (const mode of ["onReturn", "beforeCacheExpires"] as const) {
      const settings = decodeServerSettings({
        idleCompaction: mode,
        providerInstances: {
          claude_work: { driver: "claudeAgent", config: { idleCompaction: mode } },
        },
      });
      expect(resolveIdleCompaction(settings, CLAUDE)).toBe("off");
      expect(resolveIdleCompaction(settings, CLAUDE_WORK)).toBe("off");
    }
    expect(resolveIdleCompaction(decodeServerSettings({ compactIdleThreads: true }), CLAUDE)).toBe(
      "off",
    );
  });

  it("puts the stored modes back in effect when turned on", () => {
    const settings = decodeServerSettings({
      idleCompaction: "onReturn",
      idleCompactionEnabled: true,
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "beforeCacheExpires" } },
      },
    });
    expect(resolveIdleCompaction(settings, CLAUDE)).toBe("onReturn");
    expect(resolveIdleCompaction(settings, CLAUDE_WORK)).toBe("beforeCacheExpires");
  });

  it("is patchable on its own", () => {
    expect(decodeServerSettingsPatch({ idleCompactionEnabled: true })).toEqual({
      idleCompactionEnabled: true,
    });
  });
});
