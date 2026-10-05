import { describe, expect, it } from "vite-plus/test";

import type { DictationWidgetSnapshot } from "./dictationWidgetState";
import { shouldPublishDictationSnapshot } from "./useDesktopDictationBridge";

const recording: DictationWidgetSnapshot = {
  recording: true,
  transcribing: false,
  deliveredAt: null,
  live: true,
  session: {
    sessionId: "session-1",
    mode: "submit",
    startedAt: 1_000,
    bankedMs: 0,
    runningSince: 1_000,
    level: 0.2,
    sampledAt: 1_100,
  },
  mode: "submit",
  target: "Dictation fence",
  transcribingCount: 0,
  delivered: null,
  failedAt: null,
  failed: null,
};
const sampled = { ...recording, session: { ...recording.session!, level: 0.6, sampledAt: 1_200 } };

describe("dictation phase 6 rework: widget publication rate", () => {
  it("dictation phase 6 rework: a level sample waits while the window has focus and goes out when it does not", () => {
    const decide = (documentFocused: boolean) =>
      shouldPublishDictationSnapshot({
        snapshot: sampled,
        lastPublished: recording,
        documentFocused,
      });
    expect(decide(true)).toBe(false);
    expect(decide(false)).toBe(true);
  });

  it("dictation phase 6 rework: lifecycle changes go out with or without focus", () => {
    for (const snapshot of [
      { ...sampled, mode: "inject" as const },
      { ...sampled, session: { ...sampled.session, runningSince: null } },
      { ...recording, recording: false, session: null, transcribing: true, live: true },
      { ...recording, failedAt: 5_000, failed: { jobId: "job-1", at: 5_000, target: null } },
    ]) {
      expect(
        shouldPublishDictationSnapshot({
          snapshot,
          lastPublished: recording,
          documentFocused: true,
        }),
        JSON.stringify(snapshot),
      ).toBe(true);
    }
  });

  it("dictation phase 6 rework: an unchanged snapshot is not sent again", () => {
    expect(
      shouldPublishDictationSnapshot({
        snapshot: recording,
        lastPublished: recording,
        documentFocused: false,
      }),
    ).toBe(false);
  });
});
