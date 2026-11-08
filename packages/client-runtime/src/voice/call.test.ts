import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceTranscriptAppendInput, VoiceTranscriptFragment } from "@t3tools/contracts";
import type { LiveVoiceTransport } from "./browserTransport.ts";
import { createVoiceCall, type VoiceCallTransportHandlers } from "./call.ts";
import type { VoiceAgentRequest, VoiceConversationSnapshot } from "./conversation.ts";
import type {
  VoiceHistoryOwner,
  VoiceHistoryPendingBatch,
  VoiceHistoryPendingStore,
} from "./history.ts";
import type { LiveVoiceEvent } from "./protocol.ts";

// The call owner composes the controller, the durable history and the transport without React,
// atoms, or Mesura Code IDs. Each host below supplies its own snapshot, dispatch, storage and IDs.

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const idleSnapshot: VoiceConversationSnapshot = {
  latestTurn: null,
  messages: [],
  session: null,
  activities: [],
};

const spoken = (delta: string, start_ms: number, end_ms: number): LiveVoiceEvent => ({
  type: "session.input_transcript.delta",
  delta,
  start_ms,
  end_ms,
});
const answer = (delta: string): LiveVoiceEvent => ({
  type: "session.output_transcript.delta",
  delta,
});
const delegation = (id: string, offset_ms: number): LiveVoiceEvent => ({
  type: "session.delegation.created",
  offset_ms,
  delegation: { id, target: "client" },
});

const makeFakeTransport = () => {
  const closing = deferred<void>();
  const transport = {
    send: vi.fn((_event: Record<string, unknown>) => undefined),
    setMuted: vi.fn((_muted: boolean) => undefined),
    close: vi.fn(() => closing.promise),
  } satisfies LiveVoiceTransport;
  return { transport, closing };
};

const makeMemoryStore = () => {
  const backing = new Map<string, VoiceHistoryPendingBatch>();
  const store: VoiceHistoryPendingStore = {
    list: async () => [...backing.values()],
    put: async (batch) => {
      backing.set(`${batch.callId}/${batch.batchId}`, batch);
    },
    remove: async (batch) => {
      backing.delete(`${batch.callId}/${batch.batchId}`);
    },
  };
  return { store, backing };
};

const makeServer = () => {
  const fragments = new Map<number, VoiceTranscriptFragment>();
  const requests: VoiceTranscriptAppendInput[] = [];
  let failing = false;
  const append = vi.fn(async (request: VoiceTranscriptAppendInput) => {
    requests.push(request);
    if (failing) throw new Error("The network is offline.");
    for (const fragment of request.fragments)
      if (!fragments.has(fragment.sequence)) fragments.set(fragment.sequence, fragment);
    return { lastSequence: Math.max(0, ...fragments.keys()) };
  });
  return {
    client: { append },
    append,
    requests,
    stored: () => [...fragments.values()].toSorted((a, b) => a.sequence - b.sequence),
    setFailing: (value: boolean) => {
      failing = value;
    },
  };
};

interface HostOptions {
  readonly idPrefix: string;
  readonly owner: VoiceHistoryOwner;
  readonly callId: string;
  readonly dispatch?: (request: VoiceAgentRequest) => Promise<void>;
  readonly store?: VoiceHistoryPendingStore;
  readonly prepare?: () => Promise<void>;
  readonly connect?: (handlers: VoiceCallTransportHandlers) => Promise<LiveVoiceTransport>;
  readonly endSession?: (lastSequence: number) => Promise<void>;
}

/** A small host: it owns IDs, storage, the backend snapshot and dispatch. No React. */
const makeHost = (options: HostOptions) => {
  const fake = makeFakeTransport();
  const memory = makeMemoryStore();
  const server = makeServer();
  const dispatched: VoiceAgentRequest[] = [];
  const errors: string[] = [];
  const captionEvents: LiveVoiceEvent[] = [];
  let handlers: VoiceCallTransportHandlers | null = null;
  let id = 0;
  const makeId = () => `${options.idPrefix}-${++id}`;
  const connect = vi.fn(
    options.connect ??
      (async (next: VoiceCallTransportHandlers) => {
        handlers = next;
        return fake.transport;
      }),
  );
  const endSession = vi.fn(options.endSession ?? (async (_lastSequence: number) => undefined));
  const call = createVoiceCall({
    callId: options.callId,
    conversation: {
      mode: "discuss",
      makeId,
      dispatch: async (request) => {
        dispatched.push(request);
        await options.dispatch?.(request);
      },
      onStatus: () => {},
      onError: (message) => errors.push(message),
    },
    history: {
      owner: options.owner,
      threadId: `${options.idPrefix}-thread`,
      store: options.store ?? memory.store,
      client: server.client,
      makeId,
    },
    ...(options.prepare ? { prepare: options.prepare } : {}),
    connect,
    endSession,
    onEvent: (event) => captionEvents.push(event),
  });
  return {
    call,
    fake,
    memory,
    server,
    dispatched,
    errors,
    captionEvents,
    connect,
    endSession,
    emit: (event: LiveVoiceEvent) => handlers!.onEvent(event),
    disconnect: (message: string) => handlers!.onDisconnect(message),
    handlers: () => handlers,
  };
};

const settle = async () => {
  await vi.advanceTimersByTimeAsync(500);
  await vi.advanceTimersByTimeAsync(0);
};

const callIdA = "thread-call-0000000001";
const ownerA: VoiceHistoryOwner = { environmentId: "environment-1", clientIdentity: "device-a" };

describe("voice call lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("voice call two hosts drive the same conversation and history contract", async () => {
    const results = [];
    for (const host of [
      makeHost({ idPrefix: "mesura-thread", owner: ownerA, callId: callIdA }),
      makeHost({
        idPrefix: "lesson-7",
        owner: { environmentId: "learning-local", clientIdentity: "learner" },
        callId: "lesson-call-000000007",
      }),
    ]) {
      await host.call.start();
      expect(host.call.state).toMatchObject({ phase: "active", audio: "live" });
      host.call.update(idleSnapshot);
      host.emit(spoken("Revisa el transporte, por favor.", 0, 900));
      host.emit(delegation("delegation-1", 900));
      host.emit(answer("Claro, se lo pido al agente."));
      await settle();
      const ending = host.call.hangup();
      host.fake.closing.resolve();
      await ending;
      results.push({
        dispatchedText: host.dispatched.map((request) => request.text),
        requestIds: host.dispatched.map((request) => request.messageId),
        stored: host.server.stored().map(({ speaker, text }) => ({ speaker, text })),
        lastSequence: host.endSession.mock.calls.at(-1)?.[0],
        state: host.call.state,
      });
    }

    const [mesura, learning] = results;
    expect(mesura!.dispatchedText).toEqual(["Revisa el transporte, por favor."]);
    expect(learning!.dispatchedText).toEqual(mesura!.dispatchedText);
    expect(mesura!.requestIds[0]).toMatch(/^mesura-thread-/);
    expect(learning!.requestIds[0]).toMatch(/^lesson-7-/);
    expect(learning!.stored).toEqual(mesura!.stored);
    expect(mesura!.stored).toEqual([
      { speaker: "user", text: "Revisa el transporte, por favor." },
      { speaker: "assistant", text: "Claro, se lo pido al agente." },
    ]);
    expect(mesura!.lastSequence).toBe(2);
    expect(learning!.state).toMatchObject({ phase: "ended", history: "saved" });
  });

  it("voice call hangup blocks new delegation and releases capture before the provider confirms", async () => {
    const host = makeHost({ idPrefix: "h", owner: ownerA, callId: callIdA });
    await host.call.start();
    host.call.update(idleSnapshot);

    void host.call.hangup();

    expect(host.fake.transport.close).toHaveBeenCalledOnce();
    expect(host.call.state).toMatchObject({ phase: "ending", audio: "closed" });
    host.emit(spoken("Borra la rama.", 0, 500));
    host.emit(delegation("after-hangup", 500));
    await settle();
    expect(host.dispatched).toEqual([]);
    expect(host.call.state.phase).toBe("ending");
  });

  it("voice call records final captions received while the provider drains, then sends the final sequence", async () => {
    const host = makeHost({ idPrefix: "h", owner: ownerA, callId: callIdA });
    await host.call.start();
    host.call.update(idleSnapshot);
    host.emit(spoken("Gracias.", 0, 400));
    await settle();

    // Navigation does not await the hangup; the owner finishes outside the component.
    void host.call.hangup();
    host.emit(answer("De nada, "));
    host.emit(answer("hasta luego."));
    await settle();
    expect(host.endSession).not.toHaveBeenCalled();

    host.emit({ type: "session.closed" });
    host.fake.closing.resolve();
    await settle();

    expect(host.server.stored().map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: "user", text: "Gracias." },
      { speaker: "assistant", text: "De nada, hasta luego." },
    ]);
    expect(host.endSession).toHaveBeenCalledOnce();
    expect(host.endSession).toHaveBeenCalledWith(host.server.stored().at(-1)!.sequence);
    expect(
      host.captionEvents.filter((event) => event.type === "session.output_transcript.delta"),
    ).toHaveLength(2);
    expect(host.memory.backing.size).toBe(0);
    expect(host.call.state).toMatchObject({
      phase: "ended",
      audio: "closed",
      provider: "confirmed",
      history: "saved",
      error: null,
    });
  });

  it("voice call hangup keeps accepted agent work and speaks no acknowledgement after closing", async () => {
    const accepted = deferred<void>();
    const host = makeHost({
      idPrefix: "h",
      owner: ownerA,
      callId: callIdA,
      dispatch: () => accepted.promise,
    });
    await host.call.start();
    host.call.update(idleSnapshot);
    host.emit(spoken("Ejecuta las pruebas.", 0, 600));
    host.emit(delegation("accepted", 600));
    await settle();
    expect(host.dispatched).toHaveLength(1);

    const ending = host.call.hangup();
    accepted.resolve();
    host.fake.closing.resolve();
    await ending;
    await settle();

    expect(host.dispatched).toHaveLength(1);
    expect(host.errors).toEqual([]);
    expect(
      host.fake.transport.send.mock.calls.some(
        ([event]) => event.content === "Okay, I’ll get started.",
      ),
    ).toBe(false);
  });

  it("voice call ends with a recoverable error when the environment does not confirm the hangup", async () => {
    const host = makeHost({
      idPrefix: "h",
      owner: ownerA,
      callId: callIdA,
      endSession: async () => {
        throw new Error("The environment is unreachable.");
      },
    });
    await host.call.start();
    host.emit(spoken("Hola.", 0, 300));
    const ending = host.call.hangup();
    host.fake.closing.resolve();
    await ending;
    await settle();

    expect(host.call.state.phase).toBe("ended");
    expect(host.call.state.provider).toBe("unconfirmed");
    expect(host.call.state.error).toEqual(expect.any(String));
    expect(host.server.stored().map((fragment) => fragment.text)).toEqual(["Hola."]);
  });

  it("voice call reports unsynchronized history separately from a confirmed provider end", async () => {
    const host = makeHost({ idPrefix: "h", owner: ownerA, callId: callIdA });
    host.server.setFailing(true);
    await host.call.start();
    host.emit(spoken("Esto queda pendiente.", 0, 300));
    const ending = host.call.hangup();
    host.fake.closing.resolve();
    await ending;
    await settle();

    expect(host.call.state).toMatchObject({ phase: "ended", provider: "confirmed" });
    expect(host.call.state.history).not.toBe("saved");
    expect(host.call.state.error).toMatch(/history/i);
    expect([...host.memory.backing.values()].flatMap((batch) => batch.fragments)).toEqual([
      expect.objectContaining({ text: "Esto queda pendiente." }),
    ]);
  });

  it("voice call checks history storage before requesting the microphone", async () => {
    const host = makeHost({
      idPrefix: "h",
      owner: ownerA,
      callId: callIdA,
      prepare: async () => {
        throw new Error("Voice history cannot be saved in this browser.");
      },
    });

    await host.call.start();

    expect(host.connect).not.toHaveBeenCalled();
    expect(host.call.state).toMatchObject({
      phase: "ended",
      error: "Voice history cannot be saved in this browser.",
    });
  });

  it("voice call cancels a pending connection without leaving an active call", async () => {
    const late = makeFakeTransport();
    const connection = deferred<LiveVoiceTransport>();
    let signal: AbortSignal | null = null;
    const host = makeHost({
      idPrefix: "h",
      owner: ownerA,
      callId: callIdA,
      connect: (handlers) => {
        signal = handlers.signal;
        return connection.promise;
      },
    });
    const starting = host.call.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.call.state.phase).toBe("connecting");

    const ending = host.call.hangup();
    expect(signal!.aborted).toBe(true);
    connection.resolve(late.transport);
    late.closing.resolve();
    await starting;
    await ending;

    expect(late.transport.close).toHaveBeenCalled();
    expect(host.call.state.phase).toBe("ended");
  });

  it("voice call reports a rejected microphone without an active call", async () => {
    const host = makeHost({
      idPrefix: "h",
      owner: ownerA,
      callId: callIdA,
      connect: async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      },
    });

    await host.call.start();

    expect(host.call.state).toMatchObject({ phase: "ended", error: "Permission denied" });
  });

  it("voice call closes with an explanation when history storage fails mid-call", async () => {
    let rejectWrites = false;
    const memory = makeMemoryStore();
    const host = makeHost({
      idPrefix: "h",
      owner: ownerA,
      callId: callIdA,
      store: {
        ...memory.store,
        put: async (batch) => {
          if (rejectWrites) throw new DOMException("Quota exceeded", "QuotaExceededError");
          await memory.store.put(batch);
        },
      },
    });
    // The server is offline, so the first batch stays stored and unconfirmed.
    host.server.setFailing(true);
    await host.call.start();
    host.emit(spoken("Primera.", 0, 300));
    await settle();
    rejectWrites = true;
    host.emit(answer("Segunda."));
    await settle();

    expect(host.fake.transport.close).toHaveBeenCalledOnce();
    expect(host.call.state.phase).not.toBe("active");
    expect(host.call.state.history).toBe("failed");
    expect(host.call.state.error).toMatch(/history/i);
    expect([...memory.backing.values()].flatMap((batch) => batch.fragments)).toEqual([
      expect.objectContaining({ text: "Primera." }),
    ]);
  });

  it("voice call ends when the provider disconnects and still records what it received", async () => {
    const host = makeHost({ idPrefix: "h", owner: ownerA, callId: callIdA });
    await host.call.start();
    host.emit(spoken("¿Sigues ahí?", 0, 300));
    host.disconnect("The audio connection dropped.");
    host.fake.closing.resolve();
    await settle();

    expect(host.call.state).toMatchObject({
      phase: "ended",
      error: "The audio connection dropped.",
    });
    expect(host.server.stored().map((fragment) => fragment.text)).toEqual(["¿Sigues ahí?"]);
  });

  it("voice call delivers controller events sent before the transport connects", async () => {
    const connection = deferred<LiveVoiceTransport>();
    const fake = makeFakeTransport();
    const host = makeHost({
      idPrefix: "h",
      owner: ownerA,
      callId: callIdA,
      connect: () => connection.promise,
    });
    const starting = host.call.start();
    host.call.update({ ...idleSnapshot, hasPendingApprovals: true });
    connection.resolve(fake.transport);
    await starting;

    expect(fake.transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.commentary.append" }),
    );
  });

  it.each(["hangup", "storage failure"])(
    "voice call revokes a suspended host dispatch before acceptance on %s",
    async (reason) => {
      const settings = deferred<void>();
      const accepted: string[] = [];
      const memory = makeMemoryStore();
      let rejectWrites = false;
      let host: ReturnType<typeof makeHost>;
      host = makeHost({
        idPrefix: "guard",
        owner: ownerA,
        callId: callIdA,
        store: {
          ...memory.store,
          put: async (batch) => {
            if (rejectWrites) throw new Error("History storage failed.");
            await memory.store.put(batch);
          },
        },
        dispatch: async (request) => {
          await settings.promise;
          if (host.call.acceptsRequests) accepted.push(request.text);
        },
      });
      await host.call.start();
      expect(host.call.acceptsRequests).toBe(true);
      host.call.update(idleSnapshot);
      host.emit(spoken("Revisa el código.", 0, 600));
      host.emit(delegation("pending-settings", 600));
      await settle();
      expect(host.dispatched).toHaveLength(1);
      if (reason === "storage failure") {
        rejectWrites = true;
        host.emit(answer("Respuesta pendiente."));
        await settle();
        expect(host.call.state.history).toBe("failed");
      }
      const ending = host.call.hangup();
      expect(host.call.acceptsRequests).toBe(false);
      settings.resolve();
      host.fake.closing.resolve();
      await ending;
      expect(accepted).toEqual([]);
    },
  );

  it.each(["reject", "throw"])(
    "voice call completes history and server cleanup when transport close fails by %s",
    async (failure) => {
      const host = makeHost({ idPrefix: "drain", owner: ownerA, callId: callIdA });
      await host.call.start();
      host.emit(spoken("Conserva este texto.", 0, 400));
      host.fake.transport.close.mockImplementation(() => {
        if (failure === "throw") throw new Error("Synthetic drain failure");
        return Promise.reject(new Error("Synthetic drain failure"));
      });

      await expect(host.call.hangup()).resolves.toBeUndefined();

      expect(host.endSession).toHaveBeenCalledOnce();
      expect(host.endSession).toHaveBeenCalledWith(1);
      expect(host.server.stored().map((fragment) => fragment.text)).toEqual([
        "Conserva este texto.",
      ]);
      expect(host.call.state).toMatchObject({ phase: "ended", history: "saved" });
      expect(host.call.state.error).toMatch(/clos|drain/i);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("voice call ends a provider session created after cancellation already completed", async () => {
    const created = deferred<void>();
    let active = false;
    let lateCreation: Promise<void> | undefined;
    const host = makeHost({
      idPrefix: "late-session",
      owner: ownerA,
      callId: callIdA,
      connect: (handlers) => {
        // The browser aborts its wait immediately; the server can still finish creating.
        lateCreation = created.promise.then(async () => {
          active = true;
          await handlers.onSessionCreated();
        });
        return new Promise((_resolve, reject) => {
          handlers.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        });
      },
      endSession: async () => {
        active = false;
      },
    });
    const starting = host.call.start();
    await vi.advanceTimersByTimeAsync(0);
    await host.call.hangup();
    await starting;
    expect(host.endSession).toHaveBeenCalledTimes(1);
    expect(host.call.state.phase).toBe("ended");

    created.resolve();
    await lateCreation;

    expect(host.endSession).toHaveBeenCalledTimes(2);
    expect(active).toBe(false);
  });

  it("voice call suppresses only the known closing diagnostic while keeping final captions and real failures", async () => {
    const host = makeHost({ idPrefix: "diagnostic", owner: ownerA, callId: callIdA });
    await host.call.start();
    const diagnostic: LiveVoiceEvent = {
      type: "error",
      error: { code: "context_injection_incomplete", message: "Context injection was cancelled." },
    };
    host.emit(diagnostic);
    expect(host.captionEvents).toContainEqual(diagnostic);
    host.captionEvents.length = 0;

    const ending = host.call.hangup();
    host.emit(diagnostic);
    host.emit(answer("Hasta luego."));
    const meaningful: LiveVoiceEvent = {
      type: "error",
      error: { code: "connection_failed", message: "The connection failed." },
    };
    host.emit(meaningful);
    host.fake.closing.resolve();
    await ending;

    expect(host.captionEvents).not.toContainEqual(diagnostic);
    expect(host.captionEvents).toContainEqual(meaningful);
    expect(host.server.stored().map((fragment) => fragment.text)).toEqual(["Hasta luego."]);
  });
});
