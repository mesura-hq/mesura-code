import { assert, describe, expect, it } from "@effect/vitest";

import {
  createVoiceSessionManager,
  VoiceSessionError,
  type CreateVoiceSessionInput,
} from "./VoiceSessionManager.ts";

interface CapturedLiveRequest {
  readonly session: {
    readonly model: string;
    readonly instructions: string;
    readonly store: boolean;
    readonly audio: { readonly output: { readonly voice: string } };
    readonly delegation: { readonly type: string; readonly acknowledgement_delay_ms?: number };
  };
  readonly transport: { readonly type: string; readonly sdp: string };
}

const sessionInput = (
  overrides: Partial<CreateVoiceSessionInput> = {},
): CreateVoiceSessionInput => ({
  sessionId: "client-session-1",
  ownerId: "owner-1",
  threadId: "thread-1",
  apiKey: "secret-api-key",
  sdp: "v=0\r\nexample-offer",
  voice: "cedar",
  language: "es",
  mode: "discuss",
  context: "Project context",
  ...overrides,
});

const providerResponse = (sessionId = "provider-session-1", sdp = "v=0\r\nanswer") =>
  new Response(JSON.stringify({ session: { id: sessionId }, transport: { sdp } }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

describe("VoiceSessionManager", () => {
  it("creates a hands-free research session with quiet task acknowledgements", async () => {
    let body: CapturedLiveRequest | undefined;
    const manager = createVoiceSessionManager({
      fetch: async (url, init) => {
        if (String(url).endsWith("/hangup")) return new Response(null, { status: 204 });
        body = JSON.parse(String(init?.body)) as CapturedLiveRequest;
        return providerResponse();
      },
    });
    try {
      await manager.create(sessionInput({ mode: "research", handsFree: true }));
      expect(body?.session.delegation).toEqual({ type: "client", acknowledgement_delay_ms: 800 });
      expect(body?.session.instructions).toContain("without looking at the screen");
      expect(body?.session.instructions).toContain("verified findings");
    } finally {
      await manager.close();
    }
  });
  it("creates the GPT-Live WebRTC session with bounded private context", async () => {
    let requestBody: CapturedLiveRequest | undefined;
    const manager = createVoiceSessionManager({
      fetch: async (input, init) => {
        if (String(input).endsWith("/hangup")) return new Response(null, { status: 204 });
        assert.equal(input, "https://api.openai.com/v1/live/sessions");
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-api-key");
        requestBody = JSON.parse(String(init?.body)) as CapturedLiveRequest;
        return providerResponse();
      },
    });
    const input = sessionInput({ context: "x".repeat(9_000) });

    const result = await manager.create(input);

    assert.deepEqual(result, { sessionId: input.sessionId, sdp: "v=0\r\nanswer" });
    assert.equal(requestBody?.session.model, "gpt-live-1");
    assert.equal(requestBody?.session.store, false);
    assert.equal(requestBody?.session.audio.output.voice, input.voice);
    assert.equal(requestBody?.transport.type, "webrtc");
    assert.equal(requestBody?.transport.sdp, input.sdp);
    assert.deepEqual(requestBody?.session.delegation, { type: "client" });
    assert.isTrue(
      requestBody?.session.instructions.includes("Generate <|SpawnThinking|> promptly"),
    );
    assert.isTrue(requestBody?.session.instructions.includes("preserve its caveats"));
    assert.isFalse(JSON.stringify(requestBody).includes("gpt-5.6-luna"));
    assert.isFalse(JSON.stringify(requestBody).includes("responses"));
    assert.isTrue(
      requestBody?.session.instructions.endsWith("x".repeat(8_000)),
      "the prompt must cap copied workspace context",
    );
    await manager.close();
  });

  it("reserves one active session per owner and makes same-ID creation idempotent", async () => {
    let resolveCreate!: (response: Response) => void;
    let createCount = 0;
    const manager = createVoiceSessionManager({
      fetch: async () => {
        createCount += 1;
        if (createCount > 1) return new Response(null, { status: 204 });
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      },
    });
    const first = manager.create(sessionInput());
    const repeated = manager.create(sessionInput());
    const competing = manager.create(sessionInput({ sessionId: "client-session-2" }));

    assert.equal(first, repeated);
    await expect(competing).rejects.toMatchObject({ status: 409 });
    assert.equal(createCount, 1);

    resolveCreate(providerResponse());
    await first;
    await manager.close();
  });

  it("isolates owner access and never hangs up a session ID collision", async () => {
    const requests: string[] = [];
    const manager = createVoiceSessionManager({
      fetch: async (input) => {
        requests.push(String(input));
        return providerResponse("same-provider-id");
      },
    });
    await manager.create(sessionInput());

    assert.throws(() => manager.heartbeat("client-session-1", "other-owner"), VoiceSessionError);
    await expect(manager.create(sessionInput({ ownerId: "other-owner" }))).rejects.toMatchObject({
      status: 404,
    });
    await expect(manager.end("client-session-1", "other-owner")).rejects.toMatchObject({
      status: 404,
    });
    assert.equal(requests.length, 1);

    await manager.end("client-session-1", "owner-1");
    assert.equal(requests.length, 2);
    assert.isTrue(requests[1]?.endsWith("/same-provider-id/hangup"));
    await manager.close();
  });

  it("accepts provider 404 as already closed after graceful client shutdown", async () => {
    const requests: string[] = [];
    const manager = createVoiceSessionManager({
      fetch: async (input) => {
        requests.push(String(input));
        if (String(input).endsWith("/hangup")) return new Response(null, { status: 404 });
        return providerResponse("gracefully-closed-session");
      },
    });
    await manager.create(sessionInput());

    await expect(manager.end("client-session-1", "owner-1")).resolves.toBeUndefined();

    assert.deepEqual(requests, [
      "https://api.openai.com/v1/live/sessions",
      "https://api.openai.com/v1/live/sessions/gracefully-closed-session/hangup",
    ]);
    await manager.close();
  });

  it("reports failed cleanup and recovers through bounded lease sweeps", async () => {
    const requests: string[] = [];
    let timestamp = 0;
    let runSweep!: () => void;
    let hangupAttempts = 0;
    const manager = createVoiceSessionManager({
      now: () => timestamp,
      sweepIntervalMs: 10,
      scheduleSweep: (sweep) => {
        runSweep = sweep;
        return () => undefined;
      },
      fetch: async (input, init) => {
        requests.push(String(input));
        if (init?.method !== "POST" || String(input).endsWith("/live/sessions")) {
          return providerResponse("retry-provider-session");
        }
        hangupAttempts += 1;
        if (hangupAttempts < 3) return new Response(null, { status: 503 });
        return new Response(null, { status: 204 });
      },
    });
    await manager.create(sessionInput());

    await expect(manager.end("client-session-1", "owner-1")).rejects.toMatchObject({
      status: 502,
      message:
        "The voice service did not confirm session cleanup. The manager will retry while cleanup remains possible.",
    });
    assert.equal(hangupAttempts, 1);
    await expect(
      manager.create(sessionInput({ sessionId: "client-session-2" })),
    ).rejects.toMatchObject({
      status: 409,
    });

    timestamp += 10;
    runSweep();
    await expect(manager.end("client-session-1", "owner-1")).rejects.toMatchObject({
      status: 502,
    });
    assert.equal(hangupAttempts, 2);

    timestamp += 10;
    runSweep();
    await manager.end("client-session-1", "owner-1");
    await Promise.resolve();
    assert.equal(hangupAttempts, 3);
    assert.equal(requests.length, 4);
    assert.isTrue(requests.slice(1).every((url) => url.endsWith("/retry-provider-session/hangup")));
    await manager.close();
  });

  it("coalesces concurrent cleanup requests", async () => {
    let resolveHangup!: (response: Response) => void;
    let hangupAttempts = 0;
    const manager = createVoiceSessionManager({
      fetch: async (input) => {
        if (String(input).endsWith("/live/sessions")) return providerResponse();
        hangupAttempts += 1;
        return new Promise<Response>((resolve) => {
          resolveHangup = resolve;
        });
      },
    });
    await manager.create(sessionInput());

    const firstEnd = manager.end("client-session-1", "owner-1");
    const secondEnd = manager.end("client-session-1", "owner-1");
    await Promise.resolve();
    assert.equal(hangupAttempts, 1);

    resolveHangup(new Response(null, { status: 204 }));
    await Promise.all([firstEnd, secondEnd]);
    await manager.close();
  });

  it("reports cleanup failure after three bounded shutdown attempts", async () => {
    const requests: string[] = [];
    const manager = createVoiceSessionManager({
      fetch: async (input) => {
        requests.push(String(input));
        if (String(input).endsWith("/hangup")) return new Response(null, { status: 503 });
        return providerResponse("shutdown-provider-session");
      },
    });
    await manager.create(sessionInput());

    await expect(manager.close()).rejects.toMatchObject({
      status: 502,
      message:
        "The voice service did not confirm session cleanup. The manager will retry while cleanup remains possible.",
    });

    assert.equal(requests.length, 4);
    assert.isTrue(
      requests.slice(1).every((url) => url.endsWith("/shutdown-provider-session/hangup")),
    );
  });

  it("hangs up a provider session when the returned SDP is invalid", async () => {
    const requests: string[] = [];
    const manager = createVoiceSessionManager({
      fetch: async (input) => {
        requests.push(String(input));
        if (requests.length === 1) return providerResponse("invalid-sdp-provider-session", "");
        return new Response(null, { status: 204 });
      },
    });

    const error = await manager.create(sessionInput()).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );

    assert.equal(error?.message, "The voice service returned an invalid session.");
    assert.deepEqual(requests, [
      "https://api.openai.com/v1/live/sessions",
      "https://api.openai.com/v1/live/sessions/invalid-sdp-provider-session/hangup",
    ]);
    await manager.close();
  });

  it("hangs up a provider call that completes after the client cancels creation", async () => {
    let resolveCreate!: (response: Response) => void;
    let createSignal: AbortSignal | undefined;
    const requests: string[] = [];
    const manager = createVoiceSessionManager({
      fetch: async (input, init) => {
        requests.push(String(input));
        if (requests.length === 1) {
          createSignal = init?.signal as AbortSignal;
          return new Promise<Response>((resolve) => {
            resolveCreate = resolve;
          });
        }
        return new Response(null, { status: 204 });
      },
    });
    const creating = manager.create(sessionInput());
    const ending = manager.end("client-session-1", "owner-1");
    assert.isFalse(
      createSignal?.aborted,
      "ending must allow provider creation to return for cleanup",
    );
    await expect(
      manager.create(sessionInput({ sessionId: "client-session-2" })),
    ).rejects.toMatchObject({
      status: 409,
    });
    await expect(manager.create(sessionInput({ ownerId: "other-owner" }))).rejects.toMatchObject({
      status: 404,
    });
    const rejectedCreation = expect(creating).rejects.toMatchObject({ status: 409 });
    resolveCreate(providerResponse("late-provider-session"));
    await rejectedCreation;
    await ending;
    assert.deepEqual(requests, [
      "https://api.openai.com/v1/live/sessions",
      "https://api.openai.com/v1/live/sessions/late-provider-session/hangup",
    ]);
    await manager.close();
  });

  it("expires sessions after a heartbeat lease and the maximum duration", async () => {
    let timestamp = 10_000;
    let runSweep!: () => void;
    const requests: string[] = [];
    const manager = createVoiceSessionManager({
      now: () => timestamp,
      heartbeatLeaseMs: 60,
      maxDurationMs: 1_000,
      sweepIntervalMs: 15,
      scheduleSweep: (sweep) => {
        runSweep = sweep;
        return () => undefined;
      },
      fetch: async (input) => {
        requests.push(String(input));
        return providerResponse();
      },
    });
    await manager.create(sessionInput());

    timestamp += 50;
    runSweep();
    manager.heartbeat("client-session-1", "owner-1");
    timestamp += 50;
    runSweep();
    assert.equal(requests.length, 1, "a fresh heartbeat keeps the session alive");

    timestamp += 61;
    runSweep();
    await Promise.resolve();
    assert.equal(requests.length, 2, "the expired lease triggers provider hangup");
    assert.isTrue(requests[1]?.endsWith("/provider-session-1/hangup"));
    await manager.close();
  });

  it("enforces maximum session duration even when heartbeats continue", async () => {
    let timestamp = 10_000;
    let runSweep!: () => void;
    const requests: string[] = [];
    const manager = createVoiceSessionManager({
      now: () => timestamp,
      heartbeatLeaseMs: 1_000,
      maxDurationMs: 100,
      scheduleSweep: (sweep) => {
        runSweep = sweep;
        return () => undefined;
      },
      fetch: async (input) => {
        requests.push(String(input));
        return providerResponse();
      },
    });
    await manager.create(sessionInput());

    timestamp += 80;
    manager.heartbeat("client-session-1", "owner-1");
    runSweep();
    assert.equal(requests.length, 1);

    timestamp += 21;
    manager.heartbeat("client-session-1", "owner-1");
    runSweep();
    await Promise.resolve();

    assert.equal(requests.length, 2);
    assert.isTrue(requests[1]?.endsWith("/provider-session-1/hangup"));
    await manager.close();
  });

  it("returns safe provider errors without exposing body text or the API key", async () => {
    const secretResponseText = "secret-api-key and private provider internals";
    const manager = createVoiceSessionManager({
      fetch: async () => new Response(secretResponseText, { status: 500 }),
    });

    const error = await manager.create(sessionInput()).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );
    assert.equal(error?.message, "The voice service could not create a session.");
    assert.isFalse(error?.message.includes(secretResponseText));
    assert.isFalse(error?.message.includes("secret-api-key"));
    await manager.close();
  });
});
