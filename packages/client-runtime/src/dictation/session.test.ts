/**
 * Shared dictation decisions. Entry point: the `@t3tools/client-runtime/dictation`
 * subpath export the web client imports. These are the platform-free rules: the mode
 * cycle, when an armed draft sends, the one-prefix rule, and the
 * stop → marker → upload → start order.
 */
import { DictationJobId, type DictationMode } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  armedDraftSendDecision,
  DEFAULT_DICTATION_MODE,
  dictatedMessageText,
  nextDictationMode,
  runDictationStop,
} from "@t3tools/client-runtime/dictation";

const marker = (jobId: string) => `[Transcribing](t3-context://v1/dictation/${jobId})`;

describe("shared dictation mode cycle", () => {
  it("starts a recording in send mode", () => {
    expect(DEFAULT_DICTATION_MODE).toBe("submit");
  });

  it("cycles save, insert, send and back to save", () => {
    const seen: DictationMode[] = ["clipboard"];
    for (let step = 0; step < 3; step += 1) seen.push(nextDictationMode(seen.at(-1)!));
    expect(seen).toEqual(["clipboard", "inject", "submit", "clipboard"]);
  });
});

describe("shared armed draft send decision", () => {
  it("sends an armed draft whose last marker filled", () => {
    expect(
      armedDraftSendDecision({ armed: true, prompt: "fix the build", hasAttachments: false }),
    ).toBe("send");
  });

  it("waits while an armed draft still holds a marker", () => {
    expect(
      armedDraftSendDecision({
        armed: true,
        prompt: `fix ${marker("job-1")} and ${marker("job-2")}`,
        hasAttachments: false,
      }),
    ).toBe("wait");
  });

  it("never sends a draft that was not armed", () => {
    expect(armedDraftSendDecision({ armed: false, prompt: "typed", hasAttachments: false })).toBe(
      "wait",
    );
  });

  it("forgets the send state of a draft that was emptied", () => {
    expect(armedDraftSendDecision({ armed: true, prompt: "  ", hasAttachments: false })).toBe(
      "forget",
    );
    expect(armedDraftSendDecision({ armed: true, prompt: "", hasAttachments: true })).toBe("send");
  });
});

describe("shared dictated message text", () => {
  it("sends a dictated draft with one voiced prefix, trimmed", () => {
    expect(dictatedMessageText("  fix the build ", true)).toBe("[voiced] fix the build");
  });

  it("never stacks a second voiced prefix", () => {
    expect(dictatedMessageText("[voiced] fix the build", true)).toBe("[voiced] fix the build");
  });

  it("sends an undictated draft untouched and an empty one as empty", () => {
    expect(dictatedMessageText("fix the build", false)).toBe("fix the build");
    expect(dictatedMessageText("   ", true)).toBe("");
  });
});

describe("shared dictation stop order", () => {
  function steps(overrides: Partial<Parameters<typeof runDictationStop>[0]> = {}) {
    const calls: string[] = [];
    const input: Parameters<typeof runDictationStop>[0] = {
      jobId: DictationJobId.make("job-1"),
      mode: "submit",
      placeMarker: (jobId) => void calls.push(`marker:${jobId}`),
      armSend: () => void calls.push("arm"),
      finishRecording: async () => {
        calls.push("finish");
        return { uri: "file:///rec.m4a" };
      },
      upload: async (jobId) => {
        calls.push(`upload:${jobId}`);
        return "attachment-1";
      },
      start: async (jobId, attachmentId) => void calls.push(`start:${jobId}:${attachmentId}`),
      onFailed: (jobId, cause) => void calls.push(`failed:${jobId}:${String(cause)}`),
      ...overrides,
    };
    return { calls, input };
  }

  it("drops the marker, arms send, then uploads and starts the job in that order", async () => {
    const { calls, input } = steps();
    await expect(runDictationStop(input)).resolves.toBe("started");
    expect(calls).toEqual([
      "marker:job-1",
      "arm",
      "finish",
      "upload:job-1",
      "start:job-1:attachment-1",
    ]);
  });

  it("places no marker and arms nothing for a save-mode stop", async () => {
    const { calls, input } = steps({ mode: "clipboard" });
    await runDictationStop(input);
    expect(calls).toEqual(["finish", "upload:job-1", "start:job-1:attachment-1"]);
  });

  it("keeps the marker and reports the job failed when the upload fails", async () => {
    const { calls, input } = steps({
      upload: async () => {
        throw new Error("offline");
      },
    });
    await expect(runDictationStop(input)).resolves.toBe("failed");
    expect(calls).toEqual(["marker:job-1", "arm", "finish", "failed:job-1:Error: offline"]);
  });

  it("reports the job failed when the server refuses the start", async () => {
    const { calls, input } = steps({
      start: async () => {
        throw new Error("no key");
      },
    });
    await expect(runDictationStop(input)).resolves.toBe("failed");
    expect(calls.at(-1)).toBe("failed:job-1:Error: no key");
  });
});
