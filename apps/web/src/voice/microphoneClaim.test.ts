// Entry point: microphoneClaim.ts, the admission rule both microphone starts use: the phone
// (ThreadVoicePanel) and dictation (startDictation, behind every dictation entry point).
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  type DictationRecordingSession,
  useDictationSessionStore,
} from "../dictation/dictationSessionStore";
import { claimMicrophone, microphoneBlocker, resetMicrophoneClaimForTest } from "./microphoneClaim";

const recordingSession: DictationRecordingSession = {
  sessionId: "stt_microphone_claim_test",
  mode: "inject",
  startedAt: 0,
  bankedMs: 0,
  runningSince: 0,
  level: 0,
  sampledAt: 0,
  thread: null,
};

afterEach(() => {
  resetMicrophoneClaimForTest();
  useDictationSessionStore.setState({ session: null });
});

describe("microphone claim", () => {
  it("microphone claim taken by a call before preflight blocks dictation until released", () => {
    const call = claimMicrophone("call");
    expect(call).not.toBeNull();
    // Synchronous: the claim exists before any asynchronous history or permission check runs.
    expect(microphoneBlocker("dictation")).toMatch(/call/i);
    expect(claimMicrophone("dictation")).toBeNull();

    call!();
    expect(microphoneBlocker("dictation")).toBeNull();
    expect(claimMicrophone("dictation")).not.toBeNull();
  });

  it("microphone claim held by a closing call still blocks dictation", () => {
    const call = claimMicrophone("call");
    // Hangup starts; capture is still closing, so the call keeps its claim until it ends.
    expect(microphoneBlocker("dictation")).toMatch(/call/i);
    call!();
    expect(microphoneBlocker("dictation")).toBeNull();
  });

  it("microphone claim refuses a call while a dictation session records", () => {
    useDictationSessionStore.setState({ session: recordingSession });
    expect(microphoneBlocker("call")).toMatch(/dictation/i);
    expect(claimMicrophone("call")).toBeNull();

    useDictationSessionStore.setState({ session: null });
    expect(microphoneBlocker("call")).toBeNull();
  });

  it("microphone claim refuses a call while a dictation session is paused", () => {
    // A paused recording keeps its microphone open for resume.
    useDictationSessionStore.setState({ session: { ...recordingSession, runningSince: null } });
    expect(microphoneBlocker("call")).toMatch(/dictation/i);
    expect(claimMicrophone("call")).toBeNull();
  });

  it("microphone claim refuses a call while dictation is reserving the microphone", () => {
    const dictation = claimMicrophone("dictation");
    expect(microphoneBlocker("call")).toMatch(/dictation/i);
    expect(claimMicrophone("call")).toBeNull();
    dictation!();
    expect(claimMicrophone("call")).not.toBeNull();
  });

  it("microphone claim release is idempotent and a stale release keeps a newer claim", () => {
    const first = claimMicrophone("call");
    first!();
    const second = claimMicrophone("call");
    first!();
    expect(microphoneBlocker("dictation")).toMatch(/call/i);
    second!();
    expect(microphoneBlocker("dictation")).toBeNull();
  });
});
