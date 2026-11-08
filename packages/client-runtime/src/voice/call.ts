import type { LiveVoiceTransport } from "./browserTransport.ts";
import {
  createVoiceConversation,
  type VoiceConversationOptions,
  type VoiceConversationSnapshot,
} from "./conversation.ts";
import {
  createVoiceHistoryRecorder,
  type VoiceHistoryRecorderOptions,
  type VoiceHistorySyncState,
} from "./history.ts";
import type { LiveVoiceEvent } from "./protocol.ts";

/** The callbacks a host's transport reports to. Hanging up during connection aborts `signal`. */
export interface VoiceCallTransportHandlers {
  readonly signal: AbortSignal;
  /** Await after server creation, even if the transport already aborted its local wait. */
  readonly onSessionCreated: () => Promise<void>;
  readonly onEvent: (event: LiveVoiceEvent) => void;
  readonly onDisconnect: (message: string) => void;
}

/**
 * Three separate facts: whether local audio still runs, whether the environment confirmed the
 * provider session ended, and whether the history reached the server.
 */
export interface VoiceCallState {
  readonly phase: "idle" | "connecting" | "active" | "ending" | "ended";
  readonly audio: "off" | "live" | "closed";
  readonly provider: "none" | "live" | "closing" | "confirmed" | "unconfirmed";
  readonly history: VoiceHistorySyncState;
  readonly error: string | null;
}

export interface VoiceCallOptions {
  readonly callId: string;
  readonly conversation: Omit<VoiceConversationOptions, "send">;
  readonly history: Omit<VoiceHistoryRecorderOptions, "callId" | "onFailure" | "onStateChange">;
  /** Runs before the microphone is requested, for example to open history storage. */
  readonly prepare?: () => Promise<void>;
  readonly connect: (handlers: VoiceCallTransportHandlers) => Promise<LiveVoiceTransport>;
  /** Ends the environment's session and declares the final transcript sequence. */
  readonly endSession: (lastSequence: number) => Promise<void>;
  /** Every transport event, including the final ones received while hanging up (captions). */
  readonly onEvent?: (event: LiveVoiceEvent) => void;
  readonly onState?: (state: VoiceCallState) => void;
}

const PROVIDER_UNCONFIRMED_MESSAGE =
  "Audio is closed, but the voice service did not confirm the end of the call. Check the connection before starting another call.";
const HISTORY_UNSAVED_MESSAGE =
  "The call ended, but part of its voice history is not saved on the environment yet. This browser keeps it and sends it when the environment reconnects.";

const errorMessage = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The voice call could not connect.";

const isAbort = (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError";

/**
 * Owns one call outside any UI component: the delegation controller, the durable transcript and
 * the transport. Hanging up stops delegation and capture at once, keeps accepted agent work,
 * records the final transcript the provider delivers while it drains, then ends the session with
 * the final sequence and sends the remaining history. A host can drop its reference mid-hangup.
 */
export function createVoiceCall(options: VoiceCallOptions) {
  let state: VoiceCallState = {
    phase: "idle",
    audio: "off",
    provider: "none",
    history: "idle",
    error: null,
  };
  const abort = new AbortController();
  const outgoing: Array<Record<string, unknown>> = [];
  let transport: LiveVoiceTransport | null = null;
  let connecting: Promise<void> | null = null;
  let hangingUp: Promise<void> | null = null;
  let stopping = false;

  const setState = (next: Partial<VoiceCallState>) => {
    state = { ...state, ...next };
    options.onState?.(state);
  };

  const send = (event: Record<string, unknown>) => {
    if (stopping) return;
    if (transport) transport.send(event);
    else outgoing.push(event);
  };

  const conversation = createVoiceConversation({ ...options.conversation, send });
  const history = createVoiceHistoryRecorder({
    ...options.history,
    callId: options.callId,
    onFailure: (message) => void hangup(message),
    onStateChange: (next) => setState({ history: next }),
  });

  const onEvent = (event: LiveVoiceEvent) => {
    if (state.phase === "ended") return;
    history.event(event);
    // Keeping final events during drain previously retained this cancellation diagnostic as
    // a failed-call alert. Only this code during an owner-requested close is expected.
    if (stopping && event.type === "error" && event.error.code === "context_injection_incomplete")
      return;
    options.onEvent?.(event);
    // A closed controller ignores events; final captions still reach history and the host.
    if (!stopping) conversation.event(event);
  };

  const onDisconnect = (message: string) => void hangup(message);

  const onSessionCreated = async () => {
    if (!stopping) return;
    // The first end can precede the server's reservation. A late create must end again,
    // including after the local call already finished its cancellation cleanup.
    try {
      await options.endSession(history.lastSequence);
      setState({ provider: "confirmed" });
    } catch {
      setState({ provider: "unconfirmed", error: state.error ?? PROVIDER_UNCONFIRMED_MESSAGE });
    }
  };

  const connect = async () => {
    try {
      const connected = await options.connect({
        signal: abort.signal,
        onSessionCreated,
        onEvent,
        onDisconnect,
      });
      transport = connected;
      if (stopping) return;
      for (const event of outgoing.splice(0)) connected.send(event);
      setState({ phase: "active", audio: "live", provider: "live" });
    } catch (cause) {
      if (stopping) return;
      // A partly created session is ended like a hangup; the error stays the connection's.
      void hangup(isAbort(cause) ? null : errorMessage(cause));
    }
  };

  async function start(): Promise<void> {
    if (state.phase !== "idle") return;
    setState({ phase: "connecting" });
    if (options.prepare) {
      try {
        await options.prepare();
      } catch (cause) {
        setState({ phase: "ended", error: errorMessage(cause) });
        return;
      }
    }
    if (stopping) return;
    connecting = connect();
    await connecting;
    // A failed connection hangs up; start() settles once that ending is recorded.
    if (hangingUp) await hangingUp;
  }

  /** Idempotent. `error` explains a hangup the user did not ask for. */
  function hangup(error: string | null = null): Promise<void> {
    if (hangingUp) return hangingUp;
    if (stopping) return Promise.resolve();
    if (state.phase === "ended") return Promise.resolve();
    stopping = true;
    conversation.close();
    outgoing.length = 0;
    setState({
      phase: "ending",
      audio: state.audio === "off" ? "off" : "closed",
      provider: state.provider === "live" ? "closing" : state.provider,
      ...(error ? { error } : {}),
    });
    // Stop capture synchronously. A host close can throw before returning its drain promise;
    // neither failure may skip history completion and the environment's end request.
    let closing: Promise<void> | undefined;
    try {
      closing = transport?.close();
    } catch (cause) {
      closing = Promise.reject(cause);
    }
    if (!transport) abort.abort();
    hangingUp = (async () => {
      try {
        if (!closing && connecting) {
          await connecting;
          // A connection that completed after the hangup is closed without being used.
          if (transport) await transport.close();
        } else {
          await closing;
        }
      } catch (cause) {
        setState({
          error:
            state.error ?? `The audio connection could not finish closing: ${errorMessage(cause)}`,
        });
      }
      setState({ audio: state.audio === "off" ? "off" : "closed" });
      let lastSequence = history.lastSequence;
      try {
        lastSequence = await history.finish();
      } catch {
        setState({ error: state.error ?? HISTORY_UNSAVED_MESSAGE });
      }
      try {
        await options.endSession(lastSequence);
        if (state.provider !== "none") setState({ provider: "confirmed" });
      } catch {
        setState({
          provider: "unconfirmed",
          error: state.error ?? PROVIDER_UNCONFIRMED_MESSAGE,
        });
      }
      try {
        await history.flush();
      } catch {
        setState({ error: state.error ?? HISTORY_UNSAVED_MESSAGE });
      }
      const historyState = history.state;
      setState({
        phase: "ended",
        history: historyState,
        error:
          state.error ??
          (historyState === "saved" || historyState === "idle" ? null : HISTORY_UNSAVED_MESSAGE),
      });
    })();
    return hangingUp;
  }

  return {
    start,
    hangup,
    /** Forwards the host's thread snapshot to the delegation controller. */
    update(snapshot: VoiceConversationSnapshot) {
      conversation.update(snapshot);
    },
    /** The user message of the voice request in flight, which the host snapshot follows. */
    get activeMessageId() {
      return conversation.activeMessageId;
    },
    /** Sends a provider event, buffered until the transport connects and dropped after hangup. */
    send,
    /** Revoked synchronously on hangup, including host dispatches awaiting settings. */
    get acceptsRequests() {
      return !stopping && (state.phase === "connecting" || state.phase === "active");
    },
    setMuted(muted: boolean) {
      if (!stopping) transport?.setMuted(muted);
    },
    discardQueuedRequests() {
      conversation.discardQueuedRequests();
    },
    get state(): VoiceCallState {
      return state;
    },
  };
}

export type VoiceCall = ReturnType<typeof createVoiceCall>;
