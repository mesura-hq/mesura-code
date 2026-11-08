import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ThreadId,
  type VoiceCallSummary,
  type VoiceTranscriptAppendInput,
  type VoiceTranscriptFragment,
} from "@t3tools/contracts";
import { appendVoiceCaption, type VoiceCaption } from "./captions.ts";
import {
  createVoiceHistoryRecorder,
  resumeVoiceHistoryOutbox,
  type VoiceHistoryOwner,
  type VoiceHistoryPendingBatch,
  type VoiceHistoryPendingStore,
} from "./history.ts";
import type { LiveVoiceEvent } from "./protocol.ts";

// The in-memory store below proves the outbox logic only. Reload durability needs a real
// IndexedDB and is proved by the browser probe of apps/web/src/voice/voiceHistoryOutbox.ts.

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const owner: VoiceHistoryOwner = { environmentId: "environment-1", clientIdentity: "device-a" };

const input = (delta: string): LiveVoiceEvent => ({
  type: "session.input_transcript.delta",
  delta,
});
const output = (delta: string): LiveVoiceEvent => ({
  type: "session.output_transcript.delta",
  delta,
});

/** A backing map that outlives one store instance, the way a database outlives a page. */
const makeMemoryStore = (backing = new Map<string, VoiceHistoryPendingBatch>()) => {
  const calls: string[] = [];
  const store: VoiceHistoryPendingStore = {
    list: async () => [...backing.values()],
    put: async (batch) => {
      calls.push(`put:${batch.batchId}`);
      backing.set(`${batch.callId}/${batch.batchId}`, batch);
    },
    remove: async (batch) => {
      calls.push(`remove:${batch.batchId}`);
      backing.delete(`${batch.callId}/${batch.batchId}`);
    },
  };
  return { store, backing, calls };
};

interface ServerCall {
  ownedByRequester: boolean;
  endedAt: string | null;
  finalSequence: number | null;
}

/**
 * Mirrors the environment's history contract: exact retries are no-ops, changed batches are 409,
 * and an ended call accepts text only up to the final boundary its owner declared.
 */
const makeServer = () => {
  const batches = new Map<string, string>();
  const fragments = new Map<number, VoiceTranscriptFragment>();
  const requests: VoiceTranscriptAppendInput[] = [];
  const calls = new Map<string, ServerCall>();
  const callOf = (callId: string) => {
    if (!calls.has(callId))
      calls.set(callId, { ownedByRequester: true, endedAt: null, finalSequence: null });
    return calls.get(callId)!;
  };
  let failNext = 0;
  let stall: Promise<void> | null = null;
  const append = vi.fn(async (request: VoiceTranscriptAppendInput) => {
    requests.push(request);
    if (stall) await stall;
    if (failNext > 0) {
      failNext--;
      throw new Error("The network is offline.");
    }
    const call = callOf(request.sessionId);
    if (!call.ownedByRequester) throw Object.assign(new Error("Unavailable"), { status: 404 });
    if (
      call.endedAt !== null &&
      request.fragments.some(
        (fragment) => call.finalSequence === null || fragment.sequence > call.finalSequence,
      )
    )
      throw Object.assign(new Error("The call ended"), { status: 409 });
    const key = `${request.sessionId}/${request.batchId}`;
    const body = JSON.stringify(request.fragments);
    const previous = batches.get(key);
    if (previous !== undefined && previous !== body)
      throw Object.assign(new Error("Changed batch"), { status: 409 });
    batches.set(key, body);
    for (const fragment of request.fragments)
      if (!fragments.has(fragment.sequence)) fragments.set(fragment.sequence, fragment);
    return { lastSequence: Math.max(0, ...fragments.keys()) };
  });
  const readCall = vi.fn(
    async ({
      threadId,
      callId,
    }: {
      threadId: string;
      callId: string;
    }): Promise<VoiceCallSummary> => {
      const call = callOf(callId);
      return {
        callId,
        threadId: ThreadId.make(threadId),
        startedAt: "2026-11-08T10:00:00.000Z",
        endedAt: call.endedAt,
        endReason: call.endedAt === null ? null : "expired",
        finalSequence: call.finalSequence,
        lastSequence: Math.max(0, ...fragments.keys()),
        ownedByRequester: call.ownedByRequester,
      };
    },
  );
  const end = vi.fn(async ({ callId, lastSequence }: { callId: string; lastSequence: number }) => {
    const call = callOf(callId);
    if (call.finalSequence !== null && call.finalSequence !== lastSequence)
      throw Object.assign(new Error("Different final sequence"), { status: 409 });
    call.endedAt ??= "2026-11-08T10:05:00.000Z";
    call.finalSequence = lastSequence;
  });
  return {
    client: { append, readCall, end },
    append,
    readCall,
    end,
    requests,
    calls: (callId: string) => callOf(callId),
    stored: () => [...fragments.values()].toSorted((a, b) => a.sequence - b.sequence),
    failNextAppends: (count: number) => {
      failNext = count;
    },
    stallAppends: (until: Promise<void> | null) => {
      stall = until;
    },
  };
};

const makeRecorder = (
  overrides: {
    readonly store?: VoiceHistoryPendingStore;
    readonly server?: ReturnType<typeof makeServer>;
    readonly callId?: string;
  } = {},
) => {
  const memory = makeMemoryStore();
  const store = overrides.store ?? memory.store;
  const server = overrides.server ?? makeServer();
  const failures: string[] = [];
  let id = 0;
  const recorder = createVoiceHistoryRecorder({
    owner,
    threadId: "thread-1",
    callId: overrides.callId ?? "call-0000000000000001",
    store,
    client: server.client,
    makeId: () => `batch-${++id}`,
    onFailure: (message) => failures.push(message),
  });
  return { recorder, server, memory, failures };
};

/** Joins consecutive same-speaker fragments back into speaker turns. */
const speakerTurns = (fragments: ReadonlyArray<VoiceTranscriptFragment>) =>
  fragments.reduce<Array<{ speaker: string; text: string }>>((turns, fragment) => {
    const last = turns.at(-1);
    if (last?.speaker === fragment.speaker) last.text += fragment.text;
    else turns.push({ speaker: fragment.speaker, text: fragment.text });
    return turns;
  }, []);

const hasLoneSurrogate = (text: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);

const sentFragments = (server: ReturnType<typeof makeServer>) =>
  server.requests.flatMap((request) => request.fragments);

describe("voice history recorder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("voice history keeps exact spoken text, Unicode and order beyond the caption window", async () => {
    const { recorder, server } = makeRecorder();
    const spoken: Array<{ speaker: "user" | "assistant"; text: string }> = [];
    let captions: ReadonlyArray<VoiceCaption> = [];
    const samples = ["Café ", "👩‍👩‍👧 ", "日本語の文。", "🙂".repeat(7_000)];
    for (let turn = 0; turn < 40; turn++) {
      const speaker = turn % 2 === 0 ? "user" : "assistant";
      const parts = [`${turn}: `, samples[turn % samples.length]!, " fin."];
      spoken.push({ speaker, text: parts.join("") });
      for (const part of parts) {
        const event = speaker === "user" ? input(part) : output(part);
        captions = appendVoiceCaption(captions, event, () => String(turn));
        recorder.event(event);
      }
      // Speech arrives over time. A synchronous burst of all turns would exceed the 256 KiB
      // pending limit before any batch could be confirmed.
      await vi.advanceTimersByTimeAsync(0);
    }
    await recorder.flush();

    // The visual window stays bounded; the durable history does not.
    expect(captions).toHaveLength(30);
    const stored = server.stored();
    expect(stored.map((fragment) => fragment.sequence)).toEqual(
      stored.map((_, index) => index + 1),
    );
    expect(speakerTurns(stored)).toEqual(spoken);
    for (const fragment of stored) {
      expect(fragment.text.length).toBeGreaterThan(0);
      expect(fragment.text.length).toBeLessThanOrEqual(12_000);
      expect(hasLoneSurrogate(fragment.text)).toBe(false);
    }
  });

  it("voice history records only spoken transcript deltas, never delegation or provider control events", async () => {
    const { recorder, server } = makeRecorder();
    const events: LiveVoiceEvent[] = [
      { type: "session.started" },
      input(""),
      {
        type: "session.delegation.created",
        offset_ms: 10,
        delegation: { id: "delegation-1", target: "client" },
      },
      { type: "error", error: { message: "provider warning" } },
      output("Hola."),
      { type: "session.closed" },
    ];
    for (const event of events) recorder.event(event);
    await recorder.flush();

    expect(server.stored()).toEqual([
      expect.objectContaining({ sequence: 1, speaker: "assistant", text: "Hola." }),
    ]);
  });

  it("voice history waits 500 ms before sending a small batch", async () => {
    const { recorder, server } = makeRecorder();
    recorder.event(input("Hola"));
    await vi.advanceTimersByTimeAsync(499);
    expect(server.append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.append).toHaveBeenCalledOnce();
    expect(server.requests[0]!.fragments).toEqual([
      expect.objectContaining({ sequence: 1, speaker: "user", text: "Hola" }),
    ]);
  });

  it("voice history sends 16 KiB of UTF-8 text without waiting for the timer", async () => {
    const { recorder, server } = makeRecorder();
    // 8,192 two-byte characters are 16 KiB in UTF-8 but only 8,192 UTF-16 code units.
    recorder.event(input("ñ".repeat(8_192)));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.append).toHaveBeenCalledOnce();
    expect(
      sentFragments(server)
        .map((fragment) => fragment.text)
        .join(""),
    ).toBe("ñ".repeat(8_192));
  });

  it("voice history sends at most 32 fragments per request and each fragment once", async () => {
    const { recorder, server } = makeRecorder();
    for (let turn = 0; turn < 40; turn++)
      recorder.event(turn % 2 === 0 ? input(`user ${turn}`) : output(`agent ${turn}`));
    await vi.advanceTimersByTimeAsync(500);
    await recorder.flush();

    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of server.requests) expect(request.fragments.length).toBeLessThanOrEqual(32);
    const sequences = sentFragments(server).map((fragment) => fragment.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    expect(sequences.length).toBeGreaterThanOrEqual(40);
  });

  it("voice history stores a batch before sending it and resends the identical batch after a failure", async () => {
    const memory = makeMemoryStore();
    const server = makeServer();
    const { recorder } = makeRecorder({ store: memory.store, server });
    server.failNextAppends(1);
    recorder.event(input("Primera frase."));
    await recorder.flush();

    expect(server.requests).toHaveLength(1);
    const firstAttempt = server.requests[0]!;
    expect(memory.calls).toEqual([`put:${firstAttempt.batchId}`]);
    expect(memory.backing.size).toBe(1);
    expect(recorder.state).not.toBe("saved");

    await recorder.flush();
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]).toEqual(firstAttempt);
    expect(memory.calls).toEqual([`put:${firstAttempt.batchId}`, `remove:${firstAttempt.batchId}`]);
    expect(memory.backing.size).toBe(0);
    expect(server.stored()).toEqual(firstAttempt.fragments);
    expect(recorder.state).toBe("saved");
  });

  it("voice history keeps a later batch behind an earlier batch whose send failed", async () => {
    const { recorder, server } = makeRecorder();
    server.failNextAppends(1);
    // 40 speaker turns make two batches: 32 fragments, then 8.
    for (let turn = 0; turn < 40; turn++)
      recorder.event(turn % 2 === 0 ? input(`user ${turn}`) : output(`agent ${turn}`));
    await recorder.flush();

    expect(server.requests).toHaveLength(1);
    expect(server.stored()).toEqual([]);
    const failedBatchId = server.requests[0]!.batchId;

    await recorder.flush();
    expect(server.requests.map((request) => request.batchId)[1]).toBe(failedBatchId);
    expect(server.requests).toHaveLength(3);
    expect(server.stored().map((fragment) => fragment.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(recorder.state).toBe("saved");
  });

  it("voice history keeps recording while storage stalls and sends nothing unsaved", async () => {
    const memory = makeMemoryStore();
    const storageReady = deferred<void>();
    const store: VoiceHistoryPendingStore = {
      ...memory.store,
      put: async (batch) => {
        await storageReady.promise;
        await memory.store.put(batch);
      },
    };
    const { recorder, server } = makeRecorder({ store });
    recorder.event(input("uno "));
    await vi.advanceTimersByTimeAsync(500);
    for (let index = 0; index < 50; index++)
      expect(recorder.event(input(`${index} `))).toBe(undefined);
    expect(server.append).not.toHaveBeenCalled();

    storageReady.resolve();
    await recorder.flush();
    expect(
      sentFragments(server)
        .map((fragment) => fragment.text)
        .join(""),
    ).toBe(["uno ", ...Array.from({ length: 50 }, (_, index) => `${index} `)].join(""));
  });

  it("voice history accepts 256 KiB of pending UTF-8 text and fails the call above it", async () => {
    const server = makeServer();
    server.stallAppends(new Promise<void>(() => {}));
    const memory = makeMemoryStore();
    const { recorder, failures } = makeRecorder({ server, store: memory.store });
    // Each four-byte emoji is two UTF-16 code units: 65,536 of them are exactly 256 KiB.
    for (let index = 0; index < 16; index++) {
      recorder.event(input("🙂".repeat(4_096)));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(failures).toEqual([]);

    recorder.event(input("🙂"));
    await vi.advanceTimersByTimeAsync(500);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/history/i);
    expect(recorder.state).toBe("failed");
    const retained = [...memory.backing.values()].flatMap((batch) => batch.fragments);
    expect(retained.map((fragment) => fragment.text).join("")).toBe("🙂".repeat(65_536));

    recorder.event(input("después"));
    await vi.advanceTimersByTimeAsync(500);
    expect(
      [...memory.backing.values()]
        .flatMap((batch) => batch.fragments)
        .some((fragment) => fragment.text.includes("después")),
    ).toBe(false);
  });

  it("voice history reports a storage failure and keeps the batches it already stored", async () => {
    const memory = makeMemoryStore();
    const server = makeServer();
    server.stallAppends(new Promise<void>(() => {}));
    let rejectWrites = false;
    const store: VoiceHistoryPendingStore = {
      ...memory.store,
      put: async (batch) => {
        if (rejectWrites) throw new DOMException("Quota exceeded", "QuotaExceededError");
        await memory.store.put(batch);
      },
    };
    const { recorder, failures } = makeRecorder({ store, server });
    recorder.event(input("guardado"));
    await vi.advanceTimersByTimeAsync(500);
    rejectWrites = true;
    recorder.event(output("sin espacio"));
    await vi.advanceTimersByTimeAsync(500);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/history/i);
    expect(recorder.state).toBe("failed");
    expect([...memory.backing.values()].flatMap((batch) => batch.fragments)).toEqual([
      expect.objectContaining({ sequence: 1, text: "guardado" }),
    ]);
  });

  it("voice history finish seals the last text, returns its final sequence and ignores later events", async () => {
    const { recorder, server } = makeRecorder();
    recorder.event(input("¿Qué hiciste?"));
    recorder.event(output("Revisé el transporte."));
    const lastSequence = await recorder.finish();
    recorder.event(input("después de colgar"));
    await recorder.flush();

    expect(lastSequence).toBe(2);
    expect(recorder.lastSequence).toBe(2);
    expect(server.stored().map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: "user", text: "¿Qué hiciste?" },
      { speaker: "assistant", text: "Revisé el transporte." },
    ]);
  });
});

describe("voice history outbox resume", () => {
  const batch = (
    batchOwner: VoiceHistoryOwner,
    callId: string,
    batchId: string,
    sequence: number,
    text: string,
  ): VoiceHistoryPendingBatch => ({
    owner: batchOwner,
    threadId: "thread-1",
    callId,
    batchId,
    fragments: [{ fragmentId: `${batchId}-f`, sequence, speaker: "user", text }],
  });

  it("voice history resumes pending batches only for the same environment and client identity", async () => {
    const memory = makeMemoryStore();
    const otherIdentity = { environmentId: "environment-1", clientIdentity: "device-b" };
    const otherEnvironment = { environmentId: "environment-2", clientIdentity: "device-a" };
    for (const pending of [
      batch(owner, "call-aaaaaaaaaaaaaaaa", "own-2", 2, "segunda"),
      batch(otherIdentity, "call-bbbbbbbbbbbbbbbb", "foreign-1", 1, "ajena"),
      batch(owner, "call-aaaaaaaaaaaaaaaa", "own-1", 1, "primera"),
      batch(otherEnvironment, "call-cccccccccccccccc", "elsewhere-1", 1, "otro entorno"),
    ])
      await memory.store.put(pending);
    const server = makeServer();

    // A renewed token keeps the same verified identity: an equal owner, not the same object.
    await resumeVoiceHistoryOutbox({
      owner: { ...owner },
      store: memory.store,
      client: server.client,
    });

    expect(server.requests.map((request) => [request.sessionId, request.batchId])).toEqual([
      ["call-aaaaaaaaaaaaaaaa", "own-1"],
      ["call-aaaaaaaaaaaaaaaa", "own-2"],
    ]);
    expect([...memory.backing.values()].map((pending) => pending.batchId).toSorted()).toEqual([
      "elsewhere-1",
      "foreign-1",
    ]);
  });

  it("voice history resumes a batch after a reload without duplicating text", async () => {
    const backing = new Map<string, VoiceHistoryPendingBatch>();
    const server = makeServer();
    // The first page stores the batch; the server accepts it but the response never arrives.
    const lostResponse = {
      append: async (request: VoiceTranscriptAppendInput) => {
        await server.client.append(request);
        throw new Error("The connection dropped before the response.");
      },
    };
    const firstRecorder = createVoiceHistoryRecorder({
      owner,
      threadId: "thread-1",
      callId: "call-reload-000000001",
      store: makeMemoryStore(backing).store,
      client: lostResponse,
      makeId: () => "batch-reload-1",
      onFailure: () => {},
    });
    firstRecorder.event(input("Texto que sobrevive."));
    await firstRecorder.flush();
    expect(backing.size).toBe(1);

    // A new page with the same identity resumes from the same backing store.
    const reloaded = makeMemoryStore(backing);
    await resumeVoiceHistoryOutbox({ owner, store: reloaded.store, client: server.client });

    expect(server.requests.map((request) => request.batchId)).toEqual([
      "batch-reload-1",
      "batch-reload-1",
    ]);
    expect(server.requests[1]).toEqual(server.requests[0]);
    expect(server.stored().map((fragment) => fragment.text)).toEqual(["Texto que sobrevive."]);
    expect(backing.size).toBe(0);
  });

  it("voice history keeps a pending batch when its resume fails", async () => {
    const memory = makeMemoryStore();
    await memory.store.put(batch(owner, "call-aaaaaaaaaaaaaaaa", "own-1", 1, "primera"));
    const server = makeServer();
    server.failNextAppends(1);

    await resumeVoiceHistoryOutbox({ owner, store: memory.store, client: server.client });

    expect(server.requests).toHaveLength(1);
    expect(memory.backing.size).toBe(1);
  });

  it("voice history resume sends nothing when the environment does not confirm the owner", async () => {
    const memory = makeMemoryStore();
    await memory.store.put(batch(owner, "call-aaaaaaaaaaaaaaaa", "own-1", 1, "primera"));
    const server = makeServer();
    server.calls("call-aaaaaaaaaaaaaaaa").ownedByRequester = false;

    const result = await resumeVoiceHistoryOutbox({
      owner,
      store: memory.store,
      client: server.client,
    });

    expect(server.append).not.toHaveBeenCalled();
    expect(server.end).not.toHaveBeenCalled();
    expect(memory.backing.size).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it("voice history resume declares the boundary of a call the server ended without one", async () => {
    const memory = makeMemoryStore();
    await memory.store.put(batch(owner, "call-aaaaaaaaaaaaaaaa", "own-2", 2, "segunda"));
    await memory.store.put(batch(owner, "call-aaaaaaaaaaaaaaaa", "own-1", 1, "primera"));
    const server = makeServer();
    // The lease expired or the server restarted after the page closed: ended, no boundary.
    server.calls("call-aaaaaaaaaaaaaaaa").endedAt = "2026-11-08T10:01:00.000Z";

    await resumeVoiceHistoryOutbox({ owner, store: memory.store, client: server.client });

    expect(server.end).toHaveBeenCalledOnce();
    expect(server.end).toHaveBeenCalledWith({ callId: "call-aaaaaaaaaaaaaaaa", lastSequence: 2 });
    expect(server.end.mock.invocationCallOrder[0]!).toBeLessThan(
      server.append.mock.invocationCallOrder[0]!,
    );
    expect(server.stored().map((fragment) => fragment.text)).toEqual(["primera", "segunda"]);
    expect(memory.backing.size).toBe(0);
  });

  it("voice history resume never moves a final boundary the server already accepted", async () => {
    const memory = makeMemoryStore();
    await memory.store.put(batch(owner, "call-aaaaaaaaaaaaaaaa", "own-1", 1, "primera"));
    await memory.store.put(batch(owner, "call-aaaaaaaaaaaaaaaa", "own-2", 2, "después del final"));
    const server = makeServer();
    const call = server.calls("call-aaaaaaaaaaaaaaaa");
    call.endedAt = "2026-11-08T10:01:00.000Z";
    call.finalSequence = 1;

    const result = await resumeVoiceHistoryOutbox({
      owner,
      store: memory.store,
      client: server.client,
    });

    expect(server.end).not.toHaveBeenCalled();
    expect(server.requests.map((request) => request.batchId)).toEqual(["own-1"]);
    expect([...memory.backing.values()].map((pending) => pending.batchId)).toEqual(["own-2"]);
    expect(result.errors).toHaveLength(1);
  });

  it("voice history resume skips the call a live recorder still owns", async () => {
    const memory = makeMemoryStore();
    await memory.store.put(batch(owner, "call-live-00000000001", "live-1", 1, "en curso"));
    const server = makeServer();

    await resumeVoiceHistoryOutbox({
      owner,
      store: memory.store,
      client: server.client,
      excludeCallIds: new Set(["call-live-00000000001"]),
    });

    expect(server.readCall).not.toHaveBeenCalled();
    expect(memory.backing.size).toBe(1);
  });
});
