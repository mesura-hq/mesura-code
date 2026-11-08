import type { LiveVoiceEvent } from "./protocol.ts";

export interface LiveVoiceConnection {
  readonly sessionId: string;
  readonly sdp: string;
}

export interface LiveVoiceTransportInput {
  readonly audio: HTMLAudioElement;
  readonly signal: AbortSignal;
  readonly createSession: (sdp: string) => Promise<LiveVoiceConnection>;
  readonly onSession: (sessionId: string) => void;
  readonly onEvent: (event: LiveVoiceEvent) => void;
  readonly onDisconnect: (message: string) => void;
  readonly onPlaybackBlocked: () => void;
}

export interface LiveVoiceTransport {
  readonly send: (event: Record<string, unknown>) => void;
  readonly setMuted: (muted: boolean) => void;
  readonly close: () => Promise<void>;
}

/** Browser capabilities used by the transport. Tests can provide deterministic fakes. */
export interface LiveVoicePlatform {
  readonly getUserMedia: () => Promise<MediaStream>;
  readonly createPeerConnection: () => RTCPeerConnection;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
}

const ICE_GATHERING_TIMEOUT_MS = 10_000;
const SESSION_READY_TIMEOUT_MS = 30_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;

const browserPlatform = (): LiveVoicePlatform => ({
  getUserMedia: () =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }),
  createPeerConnection: () => new RTCPeerConnection(),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});

const cancellationError = (): DOMException => new DOMException("Cancelled", "AbortError");

const raceWithAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(cancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause);
      },
    );
  });

const readLiveVoiceEvent = (value: unknown): LiveVoiceEvent | null => {
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "session.started":
    case "session.closed":
      return { type: event.type };
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      if (typeof event.delta !== "string") return null;
      return {
        type: event.type,
        delta: event.delta,
        ...(typeof event.start_ms === "number" ? { start_ms: event.start_ms } : {}),
        ...(typeof event.end_ms === "number" ? { end_ms: event.end_ms } : {}),
      };
    case "session.delegation.created": {
      const delegation = event.delegation;
      if (
        typeof event.offset_ms !== "number" ||
        typeof delegation !== "object" ||
        delegation === null ||
        !("id" in delegation) ||
        typeof delegation.id !== "string" ||
        !("target" in delegation) ||
        typeof delegation.target !== "string"
      ) {
        return null;
      }
      return {
        type: event.type,
        offset_ms: event.offset_ms,
        delegation: { id: delegation.id, target: delegation.target },
      };
    }
    case "error": {
      const error = event.error;
      if (typeof error !== "object" || error === null || !("message" in error)) return null;
      return {
        type: "error",
        error: {
          message:
            typeof error.message === "string"
              ? error.message
              : "The voice provider returned an error.",
        },
      };
    }
    default:
      return null;
  }
};

const waitForIceGathering = (
  peer: RTCPeerConnection,
  signal: AbortSignal,
  platform: LiveVoicePlatform,
): Promise<void> => {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      platform.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", checkState);
      signal.removeEventListener("abort", abort);
    };
    const complete = () => {
      cleanup();
      resolve();
    };
    const checkState = () => {
      if (peer.iceGatheringState === "complete") complete();
    };
    const abort = () => {
      cleanup();
      reject(cancellationError());
    };
    const timeout = platform.setTimeout(() => {
      cleanup();
      reject(new Error("Microphone connection setup timed out."));
    }, ICE_GATHERING_TIMEOUT_MS);
    peer.addEventListener("icegatheringstatechange", checkState);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else checkState();
  });
};

/** Establishes the browser microphone, WebRTC audio, and client delegation channel. */
export function connectLiveVoice(input: LiveVoiceTransportInput): Promise<LiveVoiceTransport> {
  return connectLiveVoiceWithPlatform(input, browserPlatform());
}

export function connectLiveVoiceWithPlatform(
  input: LiveVoiceTransportInput,
  platform: LiveVoicePlatform,
): Promise<LiveVoiceTransport> {
  const { audio, signal } = input;
  if (signal.aborted) return Promise.reject(cancellationError());

  const peer = platform.createPeerConnection();
  const channel = peer.createDataChannel("oai-events");
  let media: MediaStream | null = null;
  let closed = false;
  let closing = false;
  let ready = false;
  let finishClose: (() => void) | null = null;
  let closePromise: Promise<void> | null = null;
  let readyResolve!: () => void;
  let readyReject!: (cause: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Attach a handler now because a disconnect can reject readiness while SDP setup is pending.
  void readyPromise.catch(() => undefined);

  const closeResources = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    media?.getTracks().forEach((track) => track.stop());
    media = null;
    channel.close();
    peer.close();
    audio.pause();
    audio.srcObject = null;
  };
  const onAbort = () => {
    readyReject(cancellationError());
    finishClose?.();
    closeResources();
  };
  const failConnection = (message: string) => {
    if (closed || closing) return;
    readyReject(new Error(message));
    input.onDisconnect(message);
    closeResources();
  };
  let readyTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;

  const waitUntilSessionReady = async () => {
    // Microphone permission and SDP negotiation have separate lifetimes. Start this clock after negotiation.
    if (!ready) {
      readyTimeout = platform.setTimeout(() => {
        readyReject(new Error("The voice connection timed out. Try again."));
      }, SESSION_READY_TIMEOUT_MS);
    }
    try {
      await readyPromise;
    } finally {
      platform.clearTimeout(readyTimeout);
    }
  };

  const onPeerStateChange = () => {
    if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
      failConnection("The audio connection dropped.");
    }
  };
  const onChannelClose = () => {
    if (!closing) failConnection("The voice connection closed.");
  };
  const onChannelMessage = (message: MessageEvent<string>) => {
    if (closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    const event = readLiveVoiceEvent(parsed);
    if (!event) return;
    input.onEvent(event);
    if (event.type === "session.started") {
      if (!ready) {
        ready = true;
        readyResolve();
      }
      return;
    }
    if (event.type === "session.closed") {
      if (closing) finishClose?.();
      else failConnection("The voice conversation ended.");
      return;
    }
    if (event.type === "error" && !ready) readyReject(new Error(event.error.message));
  };

  peer.addEventListener("connectionstatechange", onPeerStateChange);
  channel.addEventListener("close", onChannelClose);
  channel.addEventListener("message", onChannelMessage as EventListener);
  peer.addEventListener("track", ((event: RTCTrackEvent) => {
    if (closed) return;
    audio.srcObject = event.streams[0] ?? null;
    void audio.play().catch(() => {
      if (!closed) input.onPlaybackBlocked();
    });
  }) as EventListener);
  signal.addEventListener("abort", onAbort, { once: true });

  const getMediaOrAbort = (): Promise<MediaStream> => {
    const mediaPromise = platform.getUserMedia();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", onMediaAbort);
      const onMediaAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cancellationError());
      };
      signal.addEventListener("abort", onMediaAbort, { once: true });
      mediaPromise.then(
        (stream) => {
          if (settled || signal.aborted || closed) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          settled = true;
          cleanup();
          resolve(stream);
        },
        (cause: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(cause);
        },
      );
    });
  };

  const connect = async (): Promise<LiveVoiceTransport> => {
    try {
      media = await getMediaOrAbort();
      if (signal.aborted || closed) throw cancellationError();
      media.getTracks().forEach((track) => peer.addTrack(track, media!));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer, signal, platform);
      if (!peer.localDescription?.sdp)
        throw new Error("The browser did not create a microphone offer.");

      const sessionPromise = input.createSession(peer.localDescription.sdp);
      const connection = await raceWithAbort(sessionPromise, signal);
      if (signal.aborted || closed) throw cancellationError();
      input.onSession(connection.sessionId);
      await peer.setRemoteDescription({ type: "answer", sdp: connection.sdp });
      await waitUntilSessionReady();
      if (signal.aborted || closed) throw cancellationError();

      return {
        send: (event) => {
          if (!closed && channel.readyState === "open") channel.send(JSON.stringify(event));
        },
        setMuted: (muted) => {
          media?.getAudioTracks().forEach((track) => {
            track.enabled = !muted;
          });
        },
        close: () => {
          if (closePromise) return closePromise;
          closing = true;
          media?.getAudioTracks().forEach((track) => {
            track.enabled = false;
          });
          audio.pause();
          closePromise = new Promise<void>((resolve) => {
            if (closed || channel.readyState !== "open") {
              closeResources();
              resolve();
              return;
            }
            const timeout = platform.setTimeout(() => finishClose?.(), SESSION_CLOSE_TIMEOUT_MS);
            finishClose = () => {
              platform.clearTimeout(timeout);
              finishClose = null;
              closeResources();
              resolve();
            };
            try {
              channel.send(JSON.stringify({ type: "session.close" }));
            } catch {
              // The provider may close the data channel before accepting the close event.
              finishClose();
            }
          });
          return closePromise;
        },
      };
    } catch (cause) {
      platform.clearTimeout(readyTimeout);
      closeResources();
      throw cause;
    }
  };

  return connect();
}
