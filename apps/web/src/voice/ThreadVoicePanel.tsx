import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Headphones, Mic, MicOff, Phone, PhoneOff, Settings2, Volume2 } from "lucide-react";
import * as Option from "effect/Option";
import {
  VOICE_CONVERSATION_VOICES,
  type ScopedThreadRef,
  type VoiceConversationLanguage,
  type VoiceConversationMode,
  type VoiceConversationSettings,
  type VoiceConversationVoice,
} from "@t3tools/contracts";
import {
  configureVoiceConversation,
  createVoiceConversation,
  endVoiceConversation,
  heartbeatVoiceConversation,
  voiceConversationSettings,
} from "@t3tools/client-runtime/voice-conversation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { runtime } from "~/lib/runtime";
import { randomUUID } from "~/lib/utils";
import { useThread, useThreadShell } from "~/state/entities";
import { readPreparedConnection, usePreparedConnection } from "~/state/session";
import {
  connectLiveVoice,
  type LiveVoiceTransport,
} from "@t3tools/client-runtime/voice-conversation/browser";
import {
  createVoiceConversation as createVoiceController,
  type VoiceAgentRequest,
  type VoiceQueuedRequest,
} from "@t3tools/client-runtime/voice-conversation/controller";

import {
  appendVoiceCaption,
  type VoiceCaption,
} from "@t3tools/client-runtime/voice-conversation/captions";
import { VoiceCallTranscript, type VoiceCallLayout } from "./VoiceCallTranscript";

type CallPhase = "idle" | "connecting" | "connected" | "ending";
interface ActiveCall {
  readonly abort: AbortController;
  readonly sessionId: string;
  readonly conversation: ReturnType<typeof createVoiceController>;
  readonly endServerSession: () => Promise<unknown>;
  transport?: LiveVoiceTransport;
  heartbeat?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The voice request failed. Try again.";
}

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
  // Detail deltas can omit latestTurn.userMessageId. The shell restores that link,
  // which the voice controller needs to return only this request's result.
  const thread = useThread(threadRef);
  const shell = useThreadShell(threadRef);
  const preparedConnection = Option.getOrNull(usePreparedConnection(threadRef.environmentId));
  const dispatchRequestRef = useRef(dispatchRequest);
  const audioRef = useRef<HTMLAudioElement>(null);
  const callRef = useRef<ActiveCall | null>(null);
  const threadRefValue = useRef(thread);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [status, setStatus] = useState("Talk with this thread’s agent");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<VoiceConversationSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [captionSessionId, setCaptionSessionId] = useState("idle");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [voice, setVoice] = useState<VoiceConversationVoice>("marin");
  const [language, setLanguage] = useState<VoiceConversationLanguage>("es");
  const [mode, setMode] = useState<VoiceConversationMode>("discuss");
  const [handsFree, setHandsFree] = useState(true);
  const [learningSpace, setLearningSpace] = useState("");
  const [queuedRequests, setQueuedRequests] = useState<ReadonlyArray<VoiceQueuedRequest>>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [captions, setCaptions] = useState<ReadonlyArray<VoiceCaption>>([]);

  useEffect(() => {
    // A call can outlive composer selections. Resolve each request through the current composer.
    dispatchRequestRef.current = dispatchRequest;
  }, [dispatchRequest]);

  useEffect(() => {
    threadRefValue.current = thread;
    if (thread)
      callRef.current?.conversation.update({
        ...thread,
        hasPendingApprovals: shell?.hasPendingApprovals ?? false,
        hasPendingUserInput: shell?.hasPendingUserInput ?? false,
      });
  }, [thread, shell?.hasPendingApprovals, shell?.hasPendingUserInput]);

  useEffect(() => {
    let alive = true;
    if (preparedConnection) {
      void runtime.runPromise(voiceConversationSettings(preparedConnection)).then(
        (result) => {
          if (alive) setSettings(result);
        },
        (cause: unknown) => {
          if (alive) setError(errorMessage(cause));
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [preparedConnection]);

  useEffect(() => {
    // ChatView keys this panel by environment and thread, so navigation unmounts the call owner.
    return () => {
      const call = callRef.current;
      callRef.current = null;
      if (!call) return;
      call.conversation.close();
      clearInterval(call.heartbeat);
      clearTimeout(call.deadline);
      call.abort.abort();
      void call.transport?.close();
      void call.endServerSession().catch(() => {});
    };
  }, []);

  async function stopCall(message = "Call ended. The agent’s work stays in this thread.") {
    const call = callRef.current;
    if (!call) return;
    callRef.current = null;
    setPhase("ending");
    call.conversation.close();
    setQueuedRequests([]);
    setProgress(null);
    clearInterval(call.heartbeat);
    clearTimeout(call.deadline);
    if (!call.transport) call.abort.abort();
    try {
      // Let session.closed drain before HTTP hangup. Racing them drops the final provider event.
      await call.transport?.close();
      await call.endServerSession();
    } catch {
      setError(
        "Audio is closed, but the voice service did not confirm the end of the call. Check the connection before starting another call.",
      );
    } finally {
      call.abort.abort();
      setPhase("idle");
      setMuted(false);
      setStatus(message);
    }
  }

  async function startCall() {
    if (callRef.current || phase !== "idle" || !audioRef.current) return;
    setError(null);
    const prepared = readPreparedConnection(threadRef.environmentId);
    const currentThread = threadRefValue.current;
    if (!prepared || !currentThread) {
      setError("Connect to this environment and wait for the thread to load.");
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(
        "Voice needs HTTPS and microphone access. Open the shared HTTPS address in your browser.",
      );
      return;
    }
    const abort = new AbortController();
    const sessionId = randomUUID();
    const outgoing: Array<Record<string, unknown>> = [];
    // The controller can report a blocked thread before the audio connects; connecting must not hide it.
    let controllerStatus: string | null = null;
    let call: ActiveCall;
    const conversation = createVoiceController({
      mode,
      handsFree,
      learningSpace,
      makeId: randomUUID,
      onQueueChange: (requests) => {
        if (callRef.current === call) setQueuedRequests(requests);
      },
      onProgress: (summary) => {
        if (callRef.current === call) setProgress(summary);
      },
      send: (event) => {
        if (callRef.current !== call) return;
        if (call.transport) call.transport.send(event);
        else outgoing.push(event);
      },
      dispatch: async (request) => {
        if (callRef.current !== call)
          throw new Error("The call ended before the request was sent.");
        const state = threadRefValue.current;
        if (!state || state.id !== threadRef.threadId)
          throw new Error("The selected thread is no longer available.");
        await dispatchRequestRef.current(request, () => callRef.current === call);
      },
      onStatus: (next) => {
        controllerStatus = next;
        if (callRef.current === call) setStatus(next);
      },
      onError: (message) => {
        if (callRef.current === call) setError(message);
      },
    });
    call = {
      abort,
      sessionId,
      conversation,
      endServerSession: () => runtime.runPromise(endVoiceConversation(prepared, sessionId)),
    };
    callRef.current = call;
    conversation.update({
      ...currentThread,
      hasPendingApprovals: shell?.hasPendingApprovals ?? false,
      hasPendingUserInput: shell?.hasPendingUserInput ?? false,
    });
    setCaptions([]);
    setCaptionSessionId(sessionId);
    onLayoutChange("call");
    setQueuedRequests([]);
    setProgress(null);
    setMuted(false);
    setPlaybackBlocked(false);
    setPhase("connecting");
    setStatus("Connecting microphone…");
    try {
      const transport = await connectLiveVoice({
        audio: audioRef.current,
        signal: abort.signal,
        createSession: async (sdp) => {
          if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
          const result = await runtime.runPromise(
            createVoiceConversation(prepared, {
              sessionId,
              threadId: threadRef.threadId,
              sdp,
              voice,
              language,
              mode,
              handsFree,
              learningSpace,
            }),
          );
          if (abort.signal.aborted) {
            await call.endServerSession();
            throw new DOMException("Cancelled", "AbortError");
          }
          return result;
        },
        onSession: () => {},
        onEvent: (event) => {
          if (abort.signal.aborted) return;
          // Keep final captions while session.closed drains. The controller stops immediately.
          setCaptions((current) => appendVoiceCaption(current, event, randomUUID));
          if (callRef.current !== call) return;
          conversation.event(event);
          if (event.type === "error") setError(event.error.message);
        },
        onDisconnect: (message) => {
          if (callRef.current === call) void stopCall(message);
        },
        onPlaybackBlocked: () => {
          if (callRef.current === call) setPlaybackBlocked(true);
        },
      });
      if (callRef.current !== call) {
        await transport.close();
        return;
      }
      call.transport = transport;
      for (const event of outgoing) transport.send(event);
      transport.send({
        type: "session.commentary.append",
        event_id: "voice-greeting",
        delegation_id: null,
        content: language === "en" ? "Hi. I’m listening." : "Hola. Te escucho.",
      });
      call.heartbeat = setInterval(() => {
        void runtime
          .runPromise(heartbeatVoiceConversation(prepared, sessionId))
          .catch((cause: unknown) => {
            if (callRef.current === call) {
              setError(errorMessage(cause));
              void stopCall("The voice connection ended.");
            }
          });
      }, 15_000);
      call.deadline = setTimeout(
        () => {
          if (callRef.current === call)
            void stopCall("The 15-minute call ended. You can start another call in this thread.");
        },
        (settings?.maxDurationSeconds ?? 900) * 1000,
      );
      setPhase("connected");
      setStatus(controllerStatus ?? "Listening");
    } catch (cause) {
      if (callRef.current === call) {
        setError(errorMessage(cause));
        await stopCall("Could not connect");
      }
    }
  }

  async function saveKey() {
    const prepared = readPreparedConnection(threadRef.environmentId);
    if (!prepared) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await runtime.runPromise(configureVoiceConversation(prepared, apiKey)));
      setApiKey("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function toggleCall() {
    if (phase !== "idle") void stopCall();
    else if (settings?.configured === false) setShowSettings(true);
    else void startCall();
  }

  const active = phase !== "idle";
  const callControlLabel =
    phase === "ending"
      ? "Ending voice call"
      : phase === "connecting"
        ? "Cancel voice connection"
        : active
          ? "End voice call"
          : "Start voice call";
  return (
    <>
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
                  variant="ghost"
                  size="icon-sm"
                  aria-label={callControlLabel}
                  aria-pressed={active}
                  disabled={!thread || phase === "ending"}
                  className={active ? "bg-primary/10 text-primary hover:bg-primary/20" : undefined}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={toggleCall}
                />
              }
            >
              {active ? <PhoneOff aria-hidden /> : <Phone aria-hidden />}
            </TooltipTrigger>
            <TooltipPopup>{callControlLabel}</TooltipPopup>
          </Tooltip>,
          composerControlsHost,
        )}
      <section
        aria-label="Voice conversation"
        className="shrink-0 border-b border-border bg-muted/25 px-3 py-2"
      >
        <audio ref={audioRef} autoPlay />
        <div className="flex flex-wrap items-center gap-2">
          <Headphones className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" role="status">
            {status}
          </span>
          {phase === "idle" ? (
            <Button size="sm" variant="outline" onClick={toggleCall} disabled={!thread}>
              <Mic className="size-3.5" /> Talk to agent
            </Button>
          ) : (
            <>
              {phase === "connected" && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                  aria-pressed={muted}
                  onClick={() => {
                    callRef.current?.transport?.setMuted(!muted);
                    setMuted(!muted);
                  }}
                >
                  {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => void stopCall()}
                disabled={phase === "ending"}
              >
                <PhoneOff className="size-3.5" /> {phase === "connecting" ? "Cancel" : "End call"}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label="Voice settings"
            aria-expanded={showSettings}
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
        {(active || captions.length > 0 || layout !== "work") && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Call layout"
              className="inline-flex gap-0.5 rounded-lg border border-border bg-background/60 p-0.5"
            >
              {(
                [
                  ["call", "Call"],
                  ["split", "Split"],
                  ["work", "Work"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  size="xs"
                  variant={layout === value ? "secondary" : "ghost-muted"}
                  aria-pressed={layout === value}
                  onClick={() => onLayoutChange(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {layout === "call"
                ? "You + Voice"
                : layout === "split"
                  ? "Call + Working agent"
                  : "Working agent"}
            </span>
          </div>
        )}
        {layout !== "work" && (shell?.hasPendingApprovals || shell?.hasPendingUserInput) && (
          <Button
            size="sm"
            variant="warning-outline"
            className="mt-2"
            onClick={() => onLayoutChange("work")}
          >
            Open agent request
          </Button>
        )}
        {progress && phase === "connected" && layout === "work" && (
          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
            Agent progress: {progress}
          </p>
        )}
        {queuedRequests.length > 0 && (
          <div className="mt-2 rounded border border-border p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span>
                {queuedRequests.length} follow-up{queuedRequests.length === 1 ? "" : "s"} waiting
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => callRef.current?.conversation.discardQueuedRequests()}
              >
                Clear follow-ups
              </Button>
            </div>
            <ol className="list-inside list-decimal space-y-1">
              {queuedRequests.map((request) => (
                <li key={request.delegationId} className="line-clamp-2">
                  {request.text}
                </li>
              ))}
            </ol>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive-foreground">
            {error}
          </p>
        )}
        {playbackBlocked && (
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => {
              void audioRef.current?.play().then(
                () => setPlaybackBlocked(false),
                () => setError("Your browser blocked audio playback."),
              );
            }}
          >
            <Volume2 className="size-4" /> Resume audio
          </Button>
        )}
        {showSettings && (
          <div className="mt-3 space-y-3 rounded-lg border border-border bg-background p-3 text-xs">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="space-y-1">
                Conversation
                <select
                  aria-label="Conversation"
                  className="block w-full rounded border border-input bg-background p-2"
                  value={mode}
                  disabled={active}
                  onChange={(event) => setMode(event.target.value as VoiceConversationMode)}
                >
                  <option value="discuss">Discuss this repository</option>
                  <option value="research">Research a topic or client</option>
                  <option value="learn">Learn from this repository</option>
                </select>
              </label>
              <label className="space-y-1">
                Voice
                <select
                  aria-label="Voice"
                  className="block w-full rounded border border-input bg-background p-2"
                  value={voice}
                  disabled={active}
                  onChange={(event) => setVoice(event.target.value as VoiceConversationVoice)}
                >
                  {VOICE_CONVERSATION_VOICES.map((name) => (
                    <option key={name} value={name}>
                      {name[0]!.toUpperCase() + name.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                Language
                <select
                  aria-label="Language"
                  className="block w-full rounded border border-input bg-background p-2"
                  value={language}
                  disabled={active}
                  onChange={(event) => setLanguage(event.target.value as VoiceConversationLanguage)}
                >
                  <option value="es">Español rioplatense</option>
                  <option value="en">English</option>
                  <option value="mixed">Spanish + English</option>
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={handsFree}
                disabled={active}
                onChange={(event) => setHandsFree(event.target.checked)}
              />
              Short spoken answers · one question at a time
            </label>
            {mode === "learn" && (
              <label className="block space-y-1">
                Learning App space
                <input
                  className="block w-full rounded border border-input bg-background p-2"
                  value={learningSpace}
                  maxLength={120}
                  disabled={active}
                  placeholder="For example, software. Leave empty to choose by voice."
                  onChange={(event) => setLearningSpace(event.target.value)}
                />
              </label>
            )}
            <p className="text-muted-foreground">
              GPT-Live speaks with you. This thread’s agent handles questions and tools. Calls stop
              after 15 minutes. Leaving this thread ends the call.
            </p>
            <p className="text-muted-foreground">
              Keep this browser in the foreground. Screen-lock and background audio are not
              supported by this prototype. Interrupting speech leaves the agent’s work running.
            </p>
            <p className="text-muted-foreground">
              {settings === null
                ? "Checking voice setup…"
                : settings.configured
                  ? "OpenAI API key configured on this environment."
                  : "Add an OpenAI API key on this environment."}{" "}
              Voice uses separate API billing.
            </p>
            {settings?.canConfigure && (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveKey();
                }}
              >
                <input
                  aria-label="OpenAI API key"
                  autoComplete="off"
                  type="password"
                  className="min-w-0 flex-1 rounded border border-input bg-background p-2"
                  placeholder="OpenAI API key"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={active || saving}
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="submit"
                  disabled={active || saving || !apiKey.trim()}
                >
                  {saving ? "Saving…" : "Save key"}
                </Button>
                {settings?.configured && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={active || saving}
                    onClick={() => {
                      setApiKey("");
                      const prepared = readPreparedConnection(threadRef.environmentId);
                      if (prepared)
                        void runtime
                          .runPromise(configureVoiceConversation(prepared, ""))
                          .then(setSettings, (cause: unknown) => setError(errorMessage(cause)));
                    }}
                  >
                    Remove saved key
                  </Button>
                )}
              </form>
            )}
            {settings?.canConfigure === false && !settings.configured && (
              <p>Use an environment admin connection to configure the API key.</p>
            )}
            {mode === "learn" && (
              <p className="text-muted-foreground">
                The agent can read Learning App progress and save requested cards through{" "}
                <code>learn</code>. The server needs the Learning App CLI and its credentials.
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
