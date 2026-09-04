import {
  SYMMETRIA_PROTOCOL_MAJOR,
  SYMMETRIA_PROTOCOL_MINOR,
  type SymmetriaDictationSession,
  type SymmetriaDictationTarget,
} from "@symmetria/broker-contract";
import {
  CheckIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SendIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { ComposerBanner } from "../components/chat/ComposerBanner";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { CenterOutWaveform } from "./CenterOutWaveform";
import { MaterialDictationModeIcon } from "./MaterialDictationModeIcon";
import {
  claimDictationReservation,
  dictationMicrophonePresentation,
  dictationPhaseLabel,
  formatDictationTime,
  isActiveDictationSession,
  nextDictationMode,
  releaseDictationReservation,
  shouldOwnDictationPresentation,
  shouldPresentDictationInMesura,
} from "./dictationPresentation";
import { useDictationSessionStore } from "./dictationSessionStore";

const LEASE_DURATION_MS = 3_500;
const LEASE_RENEWAL_MS = 1_500;

const newIdentity = (kind: string): string => `mesura-${kind}-${randomUUID()}`;

function useDocumentPresence() {
  const read = () => ({
    focused: document.hasFocus(),
    visible: document.visibilityState === "visible",
  });
  const [presence, setPresence] = useState(read);
  useEffect(() => {
    const update = () => setPresence(read());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return presence;
}

async function sendBridgeCommand(command: unknown): Promise<unknown> {
  const bridge = window.symmetriaDictationBridge;
  if (!bridge) throw new Error("Symmetria Shell dictation is unavailable");
  return bridge.sendCommand(command);
}

const commandBase = (session: SymmetriaDictationSession, kind: string) => ({
  protocolVersion: session.protocolVersion,
  sessionId: session.sessionId,
  commandId: newIdentity(kind),
  createdAt: new Date().toISOString(),
});

export const DictationMicrophoneButton = memo(function DictationMicrophoneButton() {
  const session = useDictationSessionStore((state) => state.session);
  const bridgeAvailable = useDictationSessionStore((state) => state.bridgeAvailable);
  const error = useDictationSessionStore((state) => state.error);
  const setError = useDictationSessionStore((state) => state.setError);
  const active = isActiveDictationSession(session);
  const reservationPendingRef = useRef(false);
  const [reservationPending, setReservationPending] = useState(false);

  useEffect(() => {
    if (!active && bridgeAvailable) return;
    reservationPendingRef.current = false;
    setReservationPending(false);
  }, [active, bridgeAvailable]);

  const start = useCallback(async () => {
    if (!claimDictationReservation(reservationPendingRef)) return;
    setReservationPending(true);
    setError(null);
    try {
      const result = await sendBridgeCommand({
        type: "dictation.reserve.request",
        protocolVersion: {
          major: SYMMETRIA_PROTOCOL_MAJOR,
          minor: SYMMETRIA_PROTOCOL_MINOR,
        },
        sessionId: newIdentity("session"),
        commandId: newIdentity("reserve"),
        createdAt: new Date().toISOString(),
        source: "mesura",
      });
      if (
        typeof result === "object" &&
        result !== null &&
        (result as Record<string, unknown>)["type"] === "dictation.error"
      ) {
        throw new Error(String((result as Record<string, unknown>)["detail"] ?? "Unavailable"));
      }
    } catch (cause) {
      if (!isActiveDictationSession(useDictationSessionStore.getState().session)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      releaseDictationReservation(reservationPendingRef);
      setReservationPending(false);
    }
  }, [setError]);

  const presentation = dictationMicrophonePresentation({
    bridgeAvailable,
    error,
    active,
    reservationPending,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-disabled={presentation.disabled}
            aria-label={presentation.explanation}
            data-dictation-start-error={error ? "true" : undefined}
            data-dictation-start-pending={reservationPending ? "true" : undefined}
            className={cn(
              "rounded-full text-secondary-label transition-colors",
              error && "text-destructive hover:text-destructive",
              presentation.disabled && "cursor-default opacity-45",
            )}
            onClick={() => {
              if (!presentation.disabled) void start();
            }}
          >
            <MicIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {presentation.explanation}
      </TooltipPopup>
    </Tooltip>
  );
});

const StripButton = memo(function StripButton(props: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  modeControl?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            disabled={props.disabled}
            data-dictation-mode-control={props.modeControl ? "true" : undefined}
            data-dictation-control="true"
            className={cn(
              "flex size-7 cursor-pointer items-center justify-center rounded-full border border-border/55 bg-background/35 text-secondary-label shadow-xs backdrop-blur-md transition-[color,background-color,border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:scale-[1.06] hover:border-foreground/20 hover:bg-foreground/10 hover:text-foreground hover:shadow-sm focus-visible:border-foreground/25 focus-visible:ring-2 focus-visible:ring-foreground/20 focus-visible:outline-none active:translate-y-0 active:scale-95",
              props.destructive &&
                "hover:border-destructive/30 hover:bg-destructive/12 hover:text-destructive",
              props.disabled && "pointer-events-none opacity-35",
            )}
            onClick={props.onClick}
          >
            {props.children}
          </button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
});

export const DictationStrip = memo(function DictationStrip(props: {
  displayedTarget: SymmetriaDictationTarget;
}) {
  const session = useDictationSessionStore((state) => state.session);
  const setError = useDictationSessionStore((state) => state.setError);
  const presence = useDocumentPresence();
  const [dismissedSessionId, setDismissedSessionId] = useState<string | null>(null);
  const leaseSessionRef = useRef(session);
  if (leaseSessionRef.current?.sessionId !== session?.sessionId) {
    leaseSessionRef.current = session;
  }
  const reducedMotion =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const shouldPresent = shouldPresentDictationInMesura({
    session,
    displayedTarget: props.displayedTarget,
    focused: presence.focused,
    visible: presence.visible,
  });
  const visible = shouldOwnDictationPresentation({
    shouldPresent,
    sessionId: session?.sessionId ?? null,
    dismissedSessionId,
  });

  const sendControl = useCallback(
    (action: string) => {
      if (!session) return;
      void sendBridgeCommand({
        type: "dictation.control",
        ...commandBase(session, action),
        action,
      }).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [session, setError],
  );

  useEffect(() => {
    const leaseSession = leaseSessionRef.current;
    if (!leaseSession || !visible) return;
    const publish = (ownsPresentation: boolean) => {
      void sendBridgeCommand({
        type: "dictation.presentation",
        ...commandBase(leaseSession, "presentation"),
        target: leaseSession.target,
        focused: ownsPresentation && document.hasFocus(),
        visible: ownsPresentation && document.visibilityState === "visible",
        displayedTarget: ownsPresentation,
        leaseExpiresAt: new Date(
          Date.now() + (ownsPresentation ? LEASE_DURATION_MS : 1),
        ).toISOString(),
      }).catch(() => undefined);
    };
    publish(true);
    const timer = window.setInterval(() => publish(true), LEASE_RENEWAL_MS);
    return () => {
      window.clearInterval(timer);
      publish(false);
    };
  }, [session?.sessionId, visible]);

  useEffect(() => {
    if (!session || session.phase !== "completed") return;
    const timer = window.setTimeout(() => setDismissedSessionId(session.sessionId), 1_800);
    return () => window.clearTimeout(timer);
  }, [session]);

  const changeMode = useCallback(() => {
    if (!session) return;
    void sendBridgeCommand({
      type: "dictation.mode.set",
      ...commandBase(session, "mode"),
      mode: nextDictationMode(session.mode),
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [session, setError]);

  if (!visible || !session) return null;

  return (
    <DictationStripBanner
      session={session}
      reducedMotion={reducedMotion}
      onControl={sendControl}
      onChangeMode={changeMode}
      onDismiss={() => setDismissedSessionId(session.sessionId)}
    />
  );
});

/**
 * The store-free presentation of one dictation session. Split from
 * `DictationStrip` so tests can render the markup directly: the wrapper reads
 * zustand, and server rendering only sees a zustand store's initial state.
 */
export function DictationStripBanner(props: {
  session: SymmetriaDictationSession;
  reducedMotion: boolean;
  onControl: (action: string) => void;
  onChangeMode: () => void;
  onDismiss: () => void;
}) {
  const { session, onControl } = props;
  const canRecordControl = session.phase === "recording" || session.phase === "paused";
  const canChangeMode =
    session.phase === "recording" ||
    session.phase === "paused" ||
    session.phase === "processing" ||
    session.phase === "grace";
  const canDismiss = session.phase === "confirming" || session.phase === "completed";
  const terminalPresentation =
    session.phase === "completed"
      ? { icon: CheckIcon, label: "Delivered", className: "text-success" }
      : null;

  // Rendered as an upstream attached composer banner, not a hand-styled
  // surface. The composer shell hides its shared glass whenever any attached
  // banner is present, so a sibling that draws its own glass shows a
  // see-through band at the overlap. Joining the attachment system gives the
  // strip the same glass, seam, and adjacency fusing as every other notice.
  return (
    <ComposerBanner.Attachment
      className="mesura-dictation-strip pointer-events-auto relative z-0"
      data-phase={session.phase}
    >
      <ComposerBanner.Root
        role="group"
        aria-label={`Voice dictation: ${dictationPhaseLabel(session.phase)}`}
      >
        <div className="flex min-h-8 items-center gap-2 px-2">
          <span className="w-12 shrink-0 font-mono text-[11px] text-secondary-label tabular-nums">
            {formatDictationTime(session)}
          </span>
          {terminalPresentation ? (
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1.5 text-xs font-medium",
                terminalPresentation.className,
              )}
            >
              <terminalPresentation.icon className="size-3.5" />
              <span>{terminalPresentation.label}</span>
            </div>
          ) : (
            <CenterOutWaveform
              key={session.sessionId}
              sessionId={session.sessionId}
              phase={session.phase}
              audioLevel={session.audioLevel}
              active
              reducedMotion={props.reducedMotion}
            />
          )}
          <span className="sr-only" role="status">
            {dictationPhaseLabel(session.phase)}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {canRecordControl ? (
              <StripButton
                label={session.phase === "paused" ? "Resume recording" : "Pause recording"}
                onClick={() => onControl(session.phase === "paused" ? "resume" : "pause")}
              >
                {session.phase === "paused" ? (
                  <PlayIcon className="size-3.5" />
                ) : (
                  <PauseIcon className="size-3.5" />
                )}
              </StripButton>
            ) : null}
            {canRecordControl ? (
              <StripButton label="Restart recording" onClick={() => onControl("restart")}>
                <RotateCcwIcon className="size-3.5" />
              </StripButton>
            ) : null}
            {canRecordControl ? (
              <StripButton label="Cancel dictation" destructive onClick={() => onControl("cancel")}>
                <XIcon className="size-3.5" />
              </StripButton>
            ) : null}
            {canRecordControl ? (
              <StripButton label="Stop and transcribe" onClick={() => onControl("stop")}>
                <SquareIcon className="size-3" />
              </StripButton>
            ) : null}
            {session.phase === "grace" ? (
              <StripButton label="Send now" onClick={() => onControl("send-now")}>
                <SendIcon className="size-3.5" />
              </StripButton>
            ) : null}
            <StripButton
              label={`Delivery mode: ${session.mode}`}
              disabled={!canChangeMode}
              modeControl
              onClick={props.onChangeMode}
            >
              <MaterialDictationModeIcon mode={session.mode} className="size-3.5" />
            </StripButton>
            {canDismiss ? (
              <StripButton label="Hide dictation status" onClick={props.onDismiss}>
                <XIcon className="size-3.5" />
              </StripButton>
            ) : null}
          </div>
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
