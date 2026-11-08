// Phase 2 fence: persisted voice history contracts. Entry points are the public schemas a
// server and every client decode: `OrchestrationEvent`, `OrchestrationCommand`,
// `ClientOrchestrationCommand`, `ExecutionEnvironmentCapabilities`, and the `voice` group of
// `EnvironmentHttpApi`.
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import {
  ClientOrchestrationCommand,
  OrchestrationCommand,
  OrchestrationEvent,
} from "./orchestration.ts";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { EnvironmentHttpApi } from "./environmentHttp.ts";
import * as VoiceConversation from "./voiceConversation.ts";

const THREAD_ID = "thread-voice-contract";
const CALL_ID = "voice-call-contract-0001";
const AT = "2026-11-08T10:00:00.000Z";

const eventBase = (sequence: number) => ({
  sequence,
  eventId: `event-voice-${sequence}`,
  aggregateKind: "thread",
  aggregateId: THREAD_ID,
  occurredAt: AT,
  commandId: `command-voice-${sequence}`,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const fragment = {
  fragmentId: "fragment-0001",
  sequence: 1,
  speaker: "user",
  // Realtime transcript deltas keep leading spaces and punctuation; storage keeps them exactly.
  text: "  Revisá el test, ¿sí?  ",
  startOffsetMs: 0,
  endOffsetMs: 1_250,
} as const;

const decodeEvent = Schema.decodeUnknownExit(OrchestrationEvent);
const decodeCommand = Schema.decodeUnknownExit(OrchestrationCommand);
const decodeClientCommand = Schema.decodeUnknownExit(ClientOrchestrationCommand);
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);

describe("voice history contracts phase 2 fence", () => {
  it("VH-C1 decodes the three persisted voice events as orchestration events", () => {
    const events = [
      {
        ...eventBase(1),
        type: "thread.voice-call-started",
        payload: { threadId: THREAD_ID, callId: CALL_ID, ownerKey: "owner-key-a", startedAt: AT },
      },
      {
        ...eventBase(2),
        type: "thread.voice-transcript-appended",
        payload: {
          threadId: THREAD_ID,
          callId: CALL_ID,
          batchId: "batch-0001",
          fragments: [fragment],
          appendedAt: AT,
        },
      },
      {
        ...eventBase(3),
        type: "thread.voice-call-ended",
        payload: {
          threadId: THREAD_ID,
          callId: CALL_ID,
          reason: "hangup",
          lastSequence: 1,
          endedAt: AT,
        },
      },
    ];
    for (const event of events) {
      const decoded = decodeEvent(event);
      expect(Exit.isSuccess(decoded), event.type).toBe(true);
    }
    const appended = decodeEvent(events[1]);
    if (!Exit.isSuccess(appended) || appended.value.type !== "thread.voice-transcript-appended") {
      throw new Error("The appended voice event did not decode.");
    }
    expect(appended.value.payload.fragments[0]?.text).toBe(fragment.text);
  });

  it("VH-C2 keeps transcript fragments to user and assistant speech with original text", () => {
    const decodeFragment = Schema.decodeUnknownExit(VoiceConversation.VoiceTranscriptFragment);
    const decoded = decodeFragment(fragment);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) expect(decoded.value.text).toBe(fragment.text);
    expect(Exit.isSuccess(decodeFragment({ ...fragment, speaker: "assistant" }))).toBe(true);
    for (const speaker of ["tool", "system", "thinking", "agent"]) {
      expect(Exit.isSuccess(decodeFragment({ ...fragment, speaker })), speaker).toBe(false);
    }
    const withoutOffsets = {
      fragmentId: "fragment-0002",
      sequence: 2,
      speaker: "user",
      text: "Hola",
    };
    expect(Exit.isSuccess(decodeFragment(withoutOffsets))).toBe(true);
  });

  it("VH-C3 accepts voice commands only as internal orchestration commands", () => {
    const appendCommand = {
      type: "thread.voice-transcript.append",
      commandId: "command-voice-append",
      threadId: THREAD_ID,
      callId: CALL_ID,
      batchId: "batch-0001",
      fragments: [fragment],
      appendedAt: AT,
    };
    expect(Exit.isSuccess(decodeCommand(appendCommand))).toBe(true);
    // Clients reach voice history only through the owner-checked voice HTTP routes.
    expect(Exit.isSuccess(decodeClientCommand(appendCommand))).toBe(false);
  });

  it("VH-C4 advertises voice history as an optional capability that older servers omit", () => {
    expect(decodeCapabilities({ repositoryIdentity: true }).voiceHistory ?? false).toBe(false);
    expect(decodeCapabilities({ repositoryIdentity: true, voiceHistory: true }).voiceHistory).toBe(
      true,
    );
  });

  it("VH-C5 exposes transcript append and paginated history reads in the voice group", () => {
    const endpoints = Object.keys(EnvironmentHttpApi.groups.voice.endpoints);
    expect(endpoints).toEqual(
      expect.arrayContaining(["appendTranscript", "listCalls", "listFragments"]),
    );
    expect(VoiceConversation.VOICE_HISTORY_MAX_PAGE_SIZE).toBeGreaterThan(0);
    expect(VoiceConversation.VOICE_HISTORY_MAX_PAGE_SIZE).toBeLessThan(1_000);
  });
});
