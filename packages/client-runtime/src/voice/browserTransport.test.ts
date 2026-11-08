import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { connectLiveVoiceWithPlatform, type LiveVoicePlatform } from "./browserTransport.ts";

class FakeMediaTrack {
  enabled = true;
  stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  readonly audioTrack = new FakeMediaTrack();

  getTracks(): FakeMediaTrack[] {
    return [this.audioTrack];
  }

  getAudioTracks(): FakeMediaTrack[] {
    return [this.audioTrack];
  }
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  readonly sent: string[] = [];
  onSend: ((data: string) => void) | null = null;
  throwOnSend = false;

  send(data: string): void {
    if (this.throwOnSend) throw new Error("data channel is closed");
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  receive(event: unknown): void {
    const message = new MessageEvent("message", { data: JSON.stringify(event) });
    this.dispatchEvent(message);
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  readonly channel = new FakeDataChannel();
  readonly addedTracks: MediaStreamTrack[] = [];
  closed = false;

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    this.addedTracks.push(track);
    return {} as RTCRtpSender;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    this.channel.receive({ type: "session.started" });
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  disconnect(): void {
    this.connectionState = "disconnected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

class FakeAudioElement {
  srcObject: MediaProvider | null = null;
  paused = false;
  play = vi.fn(async (): Promise<void> => undefined);
  pause = vi.fn(() => {
    this.paused = true;
  });
}

const makeHarness = (options: { readonly playbackBlocked?: boolean } = {}) => {
  const stream = new FakeMediaStream();
  const peer = new FakePeerConnection();
  const audio = new FakeAudioElement();
  const onSession = vi.fn();
  const onEvent = vi.fn();
  const onDisconnect = vi.fn();
  const onPlaybackBlocked = vi.fn();
  if (options.playbackBlocked) {
    audio.play.mockRejectedValue(new Error("autoplay blocked"));
  }
  const platform: LiveVoicePlatform = {
    getUserMedia: vi.fn(async () => stream as unknown as MediaStream),
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  const input = {
    audio: audio as unknown as HTMLAudioElement,
    signal: new AbortController().signal,
    createSession: vi.fn(async (sdp: string) => {
      expect(sdp).toBe("offer-sdp");
      return { sessionId: "voice-session-1", sdp: "answer-sdp" };
    }),
    onSession,
    onEvent,
    onDisconnect,
    onPlaybackBlocked,
  };
  return {
    audio,
    input,
    onDisconnect,
    onEvent,
    onPlaybackBlocked,
    onSession,
    peer,
    platform,
    stream,
  };
};

describe("live voice transport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts the readiness deadline after a slow microphone permission decision", async () => {
    const harness = makeHarness();
    let resolveMedia!: (stream: MediaStream) => void;
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, {
      ...harness.platform,
      getUserMedia: () =>
        new Promise((resolve) => {
          resolveMedia = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.input.createSession).not.toHaveBeenCalled();
    resolveMedia(harness.stream as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    const connection = await connectionPromise;
    expect(harness.input.createSession).toHaveBeenCalledOnce();
    harness.peer.channel.onSend = (data) => {
      if (JSON.parse(data).type === "session.close")
        harness.peer.channel.receive({ type: "session.closed" });
    };
    await connection.close();
    expect(harness.stream.audioTrack.stopped).toBe(true);
  });

  it("negotiates WebRTC, forwards known events, mutes, and waits for session closure", async () => {
    const harness = makeHarness();
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    await vi.advanceTimersByTimeAsync(0);
    const connection = await connectionPromise;

    expect(harness.onSession).toHaveBeenCalledWith("voice-session-1");
    expect(harness.peer.addedTracks).toHaveLength(1);
    expect(harness.peer.remoteDescription?.sdp).toBe("answer-sdp");

    harness.peer.channel.receive({
      type: "session.input_transcript.delta",
      delta: "hello",
      start_ms: 1,
      end_ms: 2,
    });
    harness.peer.channel.receive({
      type: "session.delegation.created",
      offset_ms: 42,
      delegation: { id: "delegation-1", target: "coding-agent" },
    });
    harness.peer.channel.receive({ type: "future.unrecognized.event", payload: 1 });
    expect(harness.onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.started",
      "session.input_transcript.delta",
      "session.delegation.created",
    ]);

    connection.setMuted(true);
    expect(harness.stream.audioTrack.enabled).toBe(false);
    connection.setMuted(false);
    expect(harness.stream.audioTrack.enabled).toBe(true);
    connection.send({ type: "session.commentary.append", content: "Ready." });
    expect(JSON.parse(harness.peer.channel.sent[0]!)).toEqual({
      type: "session.commentary.append",
      content: "Ready.",
    });

    harness.peer.channel.onSend = (data) => {
      if (JSON.parse(data).type === "session.close") {
        harness.peer.channel.receive({ type: "session.closed" });
      }
    };
    await connection.close();
    expect(JSON.parse(harness.peer.channel.sent.at(-1)!)).toEqual({ type: "session.close" });
    expect(harness.stream.audioTrack.stopped).toBe(true);
    expect(harness.peer.closed).toBe(true);
    expect(harness.audio.srcObject).toBeNull();
  });

  it("stops a microphone stream that resolves after abort", async () => {
    const harness = makeHarness();
    let resolveMedia!: (stream: MediaStream) => void;
    const platform: LiveVoicePlatform = {
      ...harness.platform,
      getUserMedia: () =>
        new Promise((resolve) => {
          resolveMedia = resolve;
        }),
    };
    const controller = new AbortController();
    const connectPromise = connectLiveVoiceWithPlatform(
      { ...harness.input, signal: controller.signal },
      platform,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(connectPromise).rejects.toMatchObject({ name: "AbortError" });

    resolveMedia(harness.stream as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.stream.audioTrack.stopped).toBe(true);
    expect(harness.peer.closed).toBe(true);
  });

  it("reports blocked playback and unexpected network loss", async () => {
    const harness = makeHarness({ playbackBlocked: true });
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    await vi.advanceTimersByTimeAsync(0);
    const connection = await connectionPromise;
    const trackEvent = new Event("track") as RTCTrackEvent;
    Object.defineProperty(trackEvent, "streams", { value: [harness.stream] });
    harness.peer.dispatchEvent(trackEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.onPlaybackBlocked).toHaveBeenCalledOnce();

    harness.peer.disconnect();
    expect(harness.onDisconnect).toHaveBeenCalledWith("The audio connection dropped.");
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it("ignores an autoplay rejection that arrives after the transport closes", async () => {
    const harness = makeHarness();
    let rejectPlayback!: (cause: Error) => void;
    harness.audio.play.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlayback = reject;
        }),
    );
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    await vi.advanceTimersByTimeAsync(0);
    const connection = await connectionPromise;
    const trackEvent = new Event("track") as RTCTrackEvent;
    Object.defineProperty(trackEvent, "streams", { value: [harness.stream] });
    harness.peer.dispatchEvent(trackEvent);
    harness.peer.channel.onSend = (data) => {
      if (JSON.parse(data).type === "session.close") {
        harness.peer.channel.receive({ type: "session.closed" });
      }
    };

    await connection.close();
    rejectPlayback(new Error("autoplay blocked"));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.onPlaybackBlocked).not.toHaveBeenCalled();
  });

  it("cleans up and rejects when the provider reports an error before readiness", async () => {
    const harness = makeHarness();
    harness.peer.setRemoteDescription = async (description) => {
      harness.peer.remoteDescription = description as RTCSessionDescription;
      harness.peer.channel.receive({ type: "error", error: { message: "Provider setup failed." } });
    };
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    const rejectedConnection = expect(connectionPromise).rejects.toThrow("Provider setup failed.");

    await vi.advanceTimersByTimeAsync(0);
    await rejectedConnection;

    expect(harness.onEvent).toHaveBeenCalledWith({
      type: "error",
      error: { message: "Provider setup failed." },
    });
    expect(harness.stream.audioTrack.stopped).toBe(true);
    expect(harness.peer.closed).toBe(true);
  });

  it("cleans up when ICE gathering does not complete", async () => {
    const harness = makeHarness();
    harness.peer.iceGatheringState = "gathering";
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    const rejectedConnection = expect(connectionPromise).rejects.toThrow(
      "Microphone connection setup timed out.",
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ICE_GATHERING_TIMEOUT_MS_FOR_TEST);
    await rejectedConnection;

    expect(harness.input.createSession).not.toHaveBeenCalled();
    expect(harness.stream.audioTrack.stopped).toBe(true);
    expect(harness.peer.closed).toBe(true);
  });

  it("reports an unexpected data-channel close and releases browser resources", async () => {
    const harness = makeHarness();
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    await vi.advanceTimersByTimeAsync(0);
    await connectionPromise;

    harness.peer.channel.close();

    expect(harness.onDisconnect).toHaveBeenCalledWith("The voice connection closed.");
    expect(harness.stream.audioTrack.stopped).toBe(true);
    expect(harness.peer.closed).toBe(true);
  });

  it("releases browser resources if sending the provider close event throws", async () => {
    const harness = makeHarness();
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    await vi.advanceTimersByTimeAsync(0);
    const connection = await connectionPromise;
    harness.peer.channel.throwOnSend = true;

    await expect(connection.close()).resolves.toBeUndefined();

    expect(harness.stream.audioTrack.stopped).toBe(true);
    expect(harness.peer.closed).toBe(true);
    expect(harness.audio.srcObject).toBeNull();
  });

  it("releases browser resources when the provider does not confirm close", async () => {
    const harness = makeHarness();
    const connectionPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    await vi.advanceTimersByTimeAsync(0);
    const connection = await connectionPromise;

    const closePromise = connection.close();
    expect(harness.stream.audioTrack.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await closePromise;
    expect(harness.stream.audioTrack.stopped).toBe(true);
    expect(harness.peer.closed).toBe(true);
  });

  it("fails when the provider never starts the session", async () => {
    const harness = makeHarness();
    harness.peer.setRemoteDescription = async (description) => {
      harness.peer.remoteDescription = description as RTCSessionDescription;
    };
    const connectPromise = connectLiveVoiceWithPlatform(harness.input, harness.platform);
    const rejectedConnection = expect(connectPromise).rejects.toThrow("voice connection timed out");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SESSION_READY_TIMEOUT_MS_FOR_TEST);
    await rejectedConnection;
    expect(harness.peer.closed).toBe(true);
  });
});

const SESSION_READY_TIMEOUT_MS_FOR_TEST = 30_000;
const ICE_GATHERING_TIMEOUT_MS_FOR_TEST = 10_000;
