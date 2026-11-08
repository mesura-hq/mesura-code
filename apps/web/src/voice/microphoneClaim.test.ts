// Entry point: microphoneClaim.ts, the admission rule both composer starts use: the phone
// (ThreadVoicePanel) and the dictation button (DictationMicrophoneButton).
import { SymmetriaDictationSession } from "@symmetria/broker-contract";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useDictationSessionStore } from "../symmetria/dictationSessionStore";
import { claimMicrophone, microphoneBlocker, resetMicrophoneClaimForTest } from "./microphoneClaim";

const recordingSession = Schema.decodeUnknownSync(SymmetriaDictationSession)({
  protocolVersion: { major: 1, minor: 5 },
  sessionId: "stt_microphone_claim_test",
  target: { kind: "thread", environmentId: "env_local", threadId: "thr_claim_test" },
  source: "shell",
  phase: "recording",
  mode: "inject",
  projectName: null,
  startedAt: "2026-11-08T12:00:00.000Z",
  elapsedMs: 0,
  audioLevel: null,
  graceRemainingMs: null,
  presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
});

afterEach(() => {
  resetMicrophoneClaimForTest();
  useDictationSessionStore.setState({ session: null, bridgeAvailable: false, error: null });
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

  it("microphone claim refuses a call while a shell dictation session records", () => {
    useDictationSessionStore.setState({ session: recordingSession });
    expect(microphoneBlocker("call")).toMatch(/dictation/i);
    expect(claimMicrophone("call")).toBeNull();

    useDictationSessionStore.setState({ session: null });
    expect(microphoneBlocker("call")).toBeNull();
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
