import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Phone, PhoneOff } from "lucide-react";
import * as Option from "effect/Option";
import type { ScopedThreadRef, VoiceConversationSettings } from "@t3tools/contracts";
import {
  createVoiceConversation,
  heartbeatVoiceConversation,
  voiceConversationSettings,
} from "@t3tools/client-runtime/voice-conversation";
import { useRouter } from "@tanstack/react-router";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { getClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { runtime } from "~/lib/runtime";
import { randomUUID } from "~/lib/utils";
import { useThreadProjection, useThreadShell } from "~/state/entities";
import { readPreparedConnection, usePreparedConnection } from "~/state/session";
import { connectLiveVoice } from "@t3tools/client-runtime/voice-conversation/browser";
import {
  createVoiceCall,
  type VoiceCall,
  type VoiceCallState,
} from "@t3tools/client-runtime/voice-conversation/call";
import type {
  VoiceAgentRequest,
  VoiceQueuedRequest,
} from "@t3tools/client-runtime/voice-conversation/controller";
import {
  voiceConversationSnapshotFromThread,
  type VoiceThreadProjection,
} from "@t3tools/client-runtime/voice-conversation/thread-snapshot";

import {
  appendVoiceCaption,
  type VoiceCaption,
} from "@t3tools/client-runtime/voice-conversation/captions";
import { VoiceCallTranscript, type VoiceCallLayout } from "./VoiceCallTranscript";
import { VoiceCallToolbar } from "./VoiceCallToolbar";
import { claimMicrophone, useMicrophoneBlocker } from "./microphoneClaim";
import { resolveVoiceCallPreferences } from "./voicePreferences";
import { openVoiceSettings, useEnvironmentSupportsVoiceHistory } from "./voiceHistoryNavigation";
import {
  claimVoiceHistoryCall,
  prepareVoiceHistory,
  resumePendingVoiceHistory,
} from "./voiceHistoryOutbox";

type CallPhase = "idle" | "connecting" | "connected" | "ending";

const CALL_ENDED_STATUS = "Call ended. The agent’s work stays in this thread.";
const VOICE_UNAVAILABLE = "Voice calls are unavailable on this environment";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The voice request failed. Try again.";
}

let lastVoiceError: { readonly message: string; readonly at: number } | null = null;

/**
 * Voice errors outlive the call bar, so they are shown as toasts rather than inside it. The same
 * failure often arrives from the transport and from the call state at once; it is shown once.
 */
function reportVoiceError(message: string) {
  const now = Date.now();
  if (lastVoiceError?.message === message && now - lastVoiceError.at < 2000) return;
  lastVoiceError = { message, at: now };
  toastManager.add({ type: "error", title: "Voice call", description: message });
}

interface VoiceThreadSource {
  readonly projection:
    | (VoiceThreadProjection & { readonly thread: { readonly id: string } })
    | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

/** Sends the call the thread as the voice controller sees it, following its request in flight. */
function updateCallSnapshot(call: VoiceCall, source: VoiceThreadSource) {
  if (!source.projection) return;
  call.update(
    voiceConversationSnapshotFromThread({
      projection: source.projection,
      ownedMessageId: call.activeMessageId,
      hasPendingApprovals: source.hasPendingApprovals,
      hasPendingUserInput: source.hasPendingUserInput,
    }),
  );
}

/** The panel's phase for a call state. The call reaches `ended` only after history settles. */
function panelPhase(state: VoiceCallState): CallPhase {
  switch (state.phase) {
    case "idle":
    case "ended":
      return "idle";
    case "connecting":
      return "connecting";
    case "active":
      return "connected";
    case "ending":
      return "ending";
  }
}

/**
 * Owns the thread's voice call. It stays mounted for the thread, whatever the view: the composer
 * phone, the call bar and the captions are portals of this one owner, so switching views or hiding
 * the bar never recreates the connection. Without a call it draws nothing but the phone.
 */
export function ThreadVoicePanel({
  threadRef,
  dispatchRequest,
  composerControlsHost,
  transcriptHost,
  bottomInset,
  layout,
  onLayoutChange,
}: {
  composerControlsHost: HTMLElement | null;
  transcriptHost: HTMLElement | null;
  bottomInset: number;
  layout: VoiceCallLayout;
  onLayoutChange: (layout: VoiceCallLayout) => void;
  threadRef: ScopedThreadRef;
  dispatchRequest: (request: VoiceAgentRequest, isCallActive: () => boolean) => Promise<void>;
}) {
  // The live projection, not the quiet one: spoken progress needs streamed assistant text.
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  // The shell carries the pending approval and input flags the call must not act through.
  const shell = useThreadShell(threadRef);
  const hasPendingApprovals = shell?.hasPendingApprovals ?? false;
  const hasPendingUserInput = shell?.hasPendingUserInput ?? false;
  const router = useRouter();
  const supported = useEnvironmentSupportsVoiceHistory(threadRef.environmentId);
  const microphoneBlocked = useMicrophoneBlocker("call");
  const preparedConnection = Option.getOrNull(usePreparedConnection(threadRef.environmentId));
  // A call outlives renders and composer selections: its callbacks reach the current props.
  const dispatchCurrentRequest = useStableCallback(dispatchRequest);
  const changeLayout = useStableCallback(onLayoutChange);
  const audioRef = useRef<HTMLAudioElement>(null);
  const callRef = useRef<VoiceCall | null>(null);
  // Set while history storage and ownership are checked, before the call exists.
  const startingRef = useRef<{ cancelled: boolean; releaseMicrophone: () => void } | null>(null);
  const mountedRef = useRef(true);
  const threadSourceRef = useRef<VoiceThreadSource>({
    projection,
    hasPendingApprovals,
    hasPendingUserInput,
  });
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [status, setStatus] = useState("Connecting…");
  const [settings, setSettings] = useState<VoiceConversationSettings | null>(null);
  const [captionSessionId, setCaptionSessionId] = useState("idle");
  const [queuedRequests, setQueuedRequests] = useState<ReadonlyArray<VoiceQueuedRequest>>([]);
  const [muted, setMuted] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [captions, setCaptions] = useState<ReadonlyArray<VoiceCaption>>([]);

  // oxlint-disable-next-line t3code/react-effect-budget -- pushes thread changes into the live call, which runs outside React
  useEffect(() => {
    threadSourceRef.current = { projection, hasPendingApprovals, hasPendingUserInput };
    const call = callRef.current;
    if (call) updateCallSnapshot(call, threadSourceRef.current);
  }, [projection, hasPendingApprovals, hasPendingUserInput]);

  // oxlint-disable-next-line t3code/react-effect-budget -- loads this connection's voice settings from the environment
  useEffect(() => {
    // Environments without voice support have no voice routes; never ask them.
    if (!preparedConnection || !supported) return;
    let alive = true;
    void runtime.runPromise(voiceConversationSettings(preparedConnection)).then(
      (result) => {
        if (alive) setSettings(result);
      },
      (cause: unknown) => {
        if (alive) reportVoiceError(errorMessage(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [preparedConnection, supported]);

  // oxlint-disable-next-line t3code/react-effect-budget -- sends stored history to the environment on mount and reconnect
  useEffect(() => {
    // On mount and on every reconnect, send the history this browser kept for earlier calls.
    // The environment's fresh owner decides; a call still recording is skipped.
    if (!preparedConnection || !supported) return;
    let alive = true;
    const environmentId = threadRef.environmentId;
    void resumePendingVoiceHistory({
      environmentId,
      readPrepared: () => readPreparedConnection(environmentId),
      isCurrent: () => alive,
    }).then(
      (result) => {
        if (alive && result?.errors[0] && !callRef.current) reportVoiceError(result.errors[0]);
      },
      (cause: unknown) => {
        if (alive && !callRef.current) reportVoiceError(errorMessage(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [preparedConnection, supported, threadRef.environmentId]);

  // oxlint-disable-next-line t3code/react-effect-budget -- ends the live call and its microphone claim on unmount
  useEffect(() => {
    mountedRef.current = true;
    // ChatView keys this panel by environment and thread, so navigation unmounts it. The call
    // stops delegation and capture now and finishes its drain and history outside React.
    return () => {
      mountedRef.current = false;
      if (startingRef.current) {
        startingRef.current.cancelled = true;
        startingRef.current.releaseMicrophone();
      }
      void callRef.current?.hangup();
      callRef.current = null;
    };
  }, []);

  /** Hang up or cancel. The view returns to Work at once; cleanup continues outside React. */
  function stopCall() {
    changeLayout("work");
    if (startingRef.current) {
      startingRef.current.cancelled = true;
      startingRef.current.releaseMicrophone();
      startingRef.current = null;
      setPhase("idle");
      return;
    }
    void callRef.current?.hangup();
  }

  async function startCall() {
    if (callRef.current || startingRef.current || phase !== "idle" || !audioRef.current) return;
    const audio = audioRef.current;
    const environmentId = threadRef.environmentId;
    const prepared = readPreparedConnection(environmentId);
    const currentThread = threadSourceRef.current.projection?.thread;
    const projectId = shell?.projectId;
    if (!prepared || !currentThread || !projectId) {
      reportVoiceError("Connect to this environment and wait for the thread to load.");
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      reportVoiceError(
        "Voice needs HTTPS and microphone access. Open the shared HTTPS address in your browser.",
      );
      return;
    }
    // The microphone is claimed before any asynchronous check, so dictation cannot start in
    // between. It is released when this start fails or is cancelled, or when the call has ended.
    const releaseMicrophone = claimMicrophone("call");
    if (!releaseMicrophone) {
      reportVoiceError(microphoneBlocked ?? "The microphone is in use.");
      return;
    }
    // Preferences apply to the next call: this call keeps the copy taken now.
    const preferences = resolveVoiceCallPreferences(getClientSettings().voiceConversation, {
      environmentId,
      projectId,
    });
    const starting = { cancelled: false, releaseMicrophone };
    startingRef.current = starting;
    setPhase("connecting");
    setStatus("Checking voice history…");
    changeLayout("call");
    let history: Awaited<ReturnType<typeof prepareVoiceHistory>>;
    try {
      // Storage and ownership are checked before the microphone is requested.
      history = await prepareVoiceHistory({
        environmentId,
        readPrepared: () => readPreparedConnection(environmentId),
        isCurrent: () => !starting.cancelled && mountedRef.current,
      });
    } catch (cause) {
      if (startingRef.current === starting) {
        startingRef.current = null;
        releaseMicrophone();
        setPhase("idle");
        changeLayout("work");
        reportVoiceError(errorMessage(cause));
      }
      return;
    }
    if (startingRef.current !== starting || starting.cancelled) return;
    startingRef.current = null;
    setSettings(history.settings);
    // Another client can remove the key after the cached settings load. The fresh preflight
    // must decide before capture starts, including when the cached request is still pending.
    if (!history.settings.configured) {
      releaseMicrophone();
      setPhase("idle");
      changeLayout("work");
      openVoiceSettings(router, threadRef);
      return;
    }

    const sessionId = randomUUID();
    const sessionPrepared = history.prepared;
    let endStatus = CALL_ENDED_STATUS;
    let connected = false;
    let endingToast: ReturnType<typeof toastManager.add> | null = null;
    // The controller can report a blocked thread before the audio connects; connecting must not hide it.
    let controllerStatus: string | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const releaseHistory = claimVoiceHistoryCall(sessionId);
    const isCurrentCall = () => mountedRef.current && callRef.current === call;
    const call: VoiceCall = createVoiceCall({
      callId: sessionId,
      conversation: {
        mode: preferences.mode,
        handsFree: preferences.handsFree,
        learningSpace: preferences.learningSpace,
        makeId: randomUUID,
        onQueueChange: (requests) => {
          if (isCurrentCall()) setQueuedRequests(requests);
        },
        onProgress: () => {},
        dispatch: async (request) => {
          // The reference survives drain for captions. It cannot also authorize a request
          // suspended in ChatView's settings persistence after hangup starts.
          const canDispatch = () => callRef.current === call && call.acceptsRequests;
          if (!canDispatch()) throw new Error("The call ended before the request was sent.");
          const state = threadSourceRef.current.projection?.thread;
          if (!state || state.id !== threadRef.threadId)
            throw new Error("The selected thread is no longer available.");
          await dispatchCurrentRequest(request, canDispatch);
        },
        onStatus: (next) => {
          controllerStatus = next;
          if (isCurrentCall()) setStatus(next);
        },
        onError: (message) => {
          if (isCurrentCall()) reportVoiceError(message);
        },
      },
      history: {
        owner: history.owner,
        threadId: threadRef.threadId,
        store: history.store,
        historyClient: history.historyClient,
        makeId: randomUUID,
      },
      connect: (handlers) =>
        connectLiveVoice({
          audio,
          signal: handlers.signal,
          createSession: async (sdp) => {
            if (handlers.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            const result = await runtime.runPromise(
              createVoiceConversation(sessionPrepared, {
                sessionId,
                threadId: threadRef.threadId,
                sdp,
                voice: preferences.voice,
                language: preferences.language,
                mode: preferences.mode,
                handsFree: preferences.handsFree,
                learningSpace: preferences.learningSpace,
              }),
            );
            await handlers.onSessionCreated();
            if (handlers.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            return result;
          },
          onSession: () => {},
          onEvent: handlers.onEvent,
          onDisconnect: handlers.onDisconnect,
          onPlaybackBlocked: () => {
            if (isCurrentCall()) setPlaybackBlocked(true);
          },
        }),
      // The end declares the final transcript boundary, so it is a history request: it is sent
      // only while the environment still confirms the owner the call recorded under.
      endSession: (lastSequence) => history.historyClient.end({ callId: sessionId, lastSequence }),
      onEvent: (event) => {
        // Final captions keep arriving while the call drains; the controller already stopped.
        if (!mountedRef.current || callRef.current !== call) return;
        setCaptions((current) => appendVoiceCaption(current, event, randomUUID));
        if (event.type === "error") reportVoiceError(event.error.message);
      },
      onState: (state) => {
        if (state.phase === "ending" || state.phase === "ended") {
          clearInterval(heartbeat);
          clearTimeout(deadline);
        }
        if (state.phase === "ended") {
          releaseHistory();
          // Capture has closed: dictation may use the microphone again.
          releaseMicrophone();
          if (endingToast !== null) {
            if (connected && !state.error)
              toastManager.update(endingToast, {
                type: "success",
                title: endStatus,
                timeout: 4000,
              });
            else toastManager.close(endingToast);
          }
        }
        if (state.phase === "ending" && connected && endingToast === null)
          endingToast = toastManager.add({ type: "loading", title: "Ending the call…" });
        if (!mountedRef.current || callRef.current !== call) return;
        setPhase(panelPhase(state));
        if (state.error) reportVoiceError(state.error);
        if (state.phase === "ending" || state.phase === "ended") {
          // Whatever ended the call, the thread returns to Work and the bar goes away.
          changeLayout("work");
          setQueuedRequests([]);
        }
        if (state.phase === "active") connected = true;
        if (state.phase === "ended") {
          callRef.current = null;
          setMuted(false);
          setPlaybackBlocked(false);
        }
      },
    });
    callRef.current = call;
    updateCallSnapshot(call, threadSourceRef.current);
    setCaptions([]);
    setCaptionSessionId(sessionId);
    setQueuedRequests([]);
    setMuted(false);
    setPlaybackBlocked(false);
    setStatus("Connecting microphone…");
    await call.start();
    if (call.state.phase !== "active") return;
    call.send({
      type: "session.commentary.append",
      event_id: "voice-greeting",
      delegation_id: null,
      content: preferences.language === "en" ? "Hi. I’m listening." : "Hola. Te escucho.",
    });
    heartbeat = setInterval(() => {
      void runtime
        .runPromise(heartbeatVoiceConversation(sessionPrepared, sessionId))
        .catch((cause: unknown) => {
          endStatus = "The voice connection ended.";
          void call.hangup(errorMessage(cause));
        });
    }, 15_000);
    deadline = setTimeout(
      () => {
        endStatus = "The 15-minute call ended. You can start another call in this thread.";
        void call.hangup();
      },
      (settings?.maxDurationSeconds ?? 900) * 1000,
    );
    if (isCurrentCall()) setStatus(controllerStatus ?? "Listening");
  }

  function pressPhone() {
    if (phase !== "idle") stopCall();
    // A missing key is the environment's setting: open it, and return here without calling.
    else if (settings?.configured === false) openVoiceSettings(router, threadRef);
    else void startCall();
  }

  const active = phase !== "idle";
  const unavailableReason = !supported ? VOICE_UNAVAILABLE : active ? null : microphoneBlocked;
  const callControlLabel =
    unavailableReason ??
    (phase === "ending"
      ? "Ending voice call"
      : phase === "connecting"
        ? "Cancel voice connection"
        : active
          ? "End voice call"
          : "Start voice call");
  return (
    <>
      <audio ref={audioRef} autoPlay className="hidden" />
      {transcriptHost &&
        createPortal(
          <VoiceCallTranscript
            key={captionSessionId}
            captions={captions}
            active={active}
            layout={layout}
            bottomInset={bottomInset}
          />,
          transcriptHost,
        )}
      {composerControlsHost &&
        createPortal(
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={active ? "secondary" : "ghost"}
                  size="icon-sm"
                  inactive={unavailableReason !== null}
                  aria-label={callControlLabel}
                  aria-pressed={active}
                  aria-disabled={unavailableReason !== null || undefined}
                  disabled={!projection || phase === "ending"}
                  className="max-sm:size-11"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (unavailableReason === null) pressPhone();
                  }}
                />
              }
            >
              {active ? <PhoneOff aria-hidden /> : <Phone aria-hidden />}
            </TooltipTrigger>
            <TooltipPopup>{callControlLabel}</TooltipPopup>
          </Tooltip>,
          composerControlsHost,
        )}
      {phase === "connecting" || phase === "connected" ? (
        <VoiceCallToolbar
          connecting={phase === "connecting"}
          status={status}
          layout={layout}
          onLayoutChange={onLayoutChange}
          muted={muted}
          onToggleMute={() => {
            callRef.current?.setMuted(!muted);
            setMuted(!muted);
          }}
          onHangup={stopCall}
          playbackBlocked={playbackBlocked}
          onResumeAudio={() => {
            void audioRef.current?.play().then(
              () => setPlaybackBlocked(false),
              () =>
                reportVoiceError("Your browser blocked audio playback. Tap Resume audio again."),
            );
          }}
          followUps={queuedRequests.length}
          onClearFollowUps={() => callRef.current?.discardQueuedRequests()}
          agentRequestWaiting={hasPendingApprovals || hasPendingUserInput}
        />
      ) : null}
    </>
  );
}
