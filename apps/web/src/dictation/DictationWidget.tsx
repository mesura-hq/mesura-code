import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { CenterOutWaveform } from "./CenterOutWaveform";
import {
  dictationRecordedElapsedMs,
  dictationRecordingPhase,
  formatDictationElapsed,
} from "./dictationPresentation";
import { MaterialDictationModeIcon } from "./MaterialDictationModeIcon";
import type { DictationWidgetSnapshot } from "./dictationWidgetState";
import { prefersReducedMotion } from "./reducedMotion";

/**
 * The floating dictation widget the desktop shows while another app has focus: the recording's
 * time, level, mode and target, then the transcription, then the delivery result. It draws the
 * state the main window publishes and nothing else.
 */
export function DictationWidget({ snapshot }: { readonly snapshot: DictationWidgetSnapshot }) {
  const { session, mode, target } = snapshot;
  let body: React.ReactNode = null;
  if (session) {
    const phase = dictationRecordingPhase(session);
    const paused = phase === "paused";
    body = (
      <>
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            paused ? "bg-dictation-paused" : "dictation-widget-rec-dot bg-dictation-recording",
          )}
        />
        <span className="font-mono text-xs tabular-nums text-dictation-label">
          {formatDictationElapsed(dictationRecordedElapsedMs(session))}
        </span>
        <div className="flex w-28">
          <CenterOutWaveform
            sessionId={session.sessionId}
            phase={phase}
            audioLevel={session.level}
            active
            reducedMotion={prefersReducedMotion()}
            className="text-dictation-wave"
          />
        </div>
        <MaterialDictationModeIcon
          mode={session.mode}
          className="size-4 shrink-0 text-dictation-label"
        />
        {target ? (
          <span className="max-w-36 truncate text-xs text-dictation-muted">→ {target}</span>
        ) : null}
        {snapshot.transcribingCount > 0 ? (
          <span className="shrink-0 text-search-label text-dictation-processing">
            +{snapshot.transcribingCount} transcribing
          </span>
        ) : null}
      </>
    );
  } else if (snapshot.failed) {
    // Shown until Mesura has focus: the user in another app must not assume it went out.
    body = (
      <span className="truncate text-xs text-dictation-error">
        {snapshot.failed.target
          ? `Transcription failed in ${snapshot.failed.target}. Open Mesura to retry.`
          : "Transcription failed. Open Mesura to retry."}
      </span>
    );
  } else if (snapshot.transcribing) {
    body = (
      <>
        {mode ? (
          <MaterialDictationModeIcon
            mode={mode}
            className="size-4 shrink-0 text-dictation-processing"
          />
        ) : null}
        <span className="dictation-widget-transcribing truncate text-xs text-dictation-processing">
          {snapshot.transcribingCount > 1
            ? `Transcribing ${snapshot.transcribingCount} recordings`
            : target
              ? `Transcribing → ${target}`
              : "Transcribing"}
        </span>
      </>
    );
  } else if (snapshot.delivered) {
    const { delivered } = snapshot;
    body = (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-dictation-success">
        <CheckIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          {delivered.mode === "clipboard"
            ? "Copied to the clipboard"
            : delivered.target
              ? `Inserted into ${delivered.target}`
              : "Inserted into the draft"}
        </span>
      </span>
    );
  }
  if (!body) return null;
  return (
    <div className="pointer-events-none flex h-full items-center justify-center font-sans">
      <div
        role="status"
        className="flex h-11 max-w-full items-center gap-2.5 rounded-full border border-white/10 bg-dictation-surface/90 px-4 shadow-xl"
      >
        {body}
      </div>
    </div>
  );
}

/** What the desktop sends: a snapshot, maybe asking to be acknowledged once rendered. */
type WidgetMessage = DictationWidgetSnapshot & { readonly ackSequence?: number };

function parseMessage(raw: unknown): WidgetMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<WidgetMessage>;
  return typeof candidate.recording === "boolean" && typeof candidate.transcribing === "boolean"
    ? (raw as WidgetMessage)
    : null;
}

/**
 * The widget window's page: the state the main process relays, drawn as the widget. `null`
 * (the window is hidden) draws nothing, so no waveform runs off screen. A message carrying an
 * `ackSequence` is acknowledged after it is committed, and only then does the desktop show the
 * window.
 */
export function DictationWidgetPage() {
  const [message, setMessage] = useState<WidgetMessage | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: subscribes to the desktop bridge's widget state for the page's lifetime
  useEffect(
    () => window.mesuraDictationBridge?.onWidgetState((raw) => setMessage(parseMessage(raw))),
    [],
  );
  const ackSequence = message?.ackSequence;
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: acknowledges the widget state to the desktop bridge after commit, so the window shows painted
  useEffect(() => {
    if (ackSequence !== undefined)
      window.mesuraDictationBridge?.acknowledgeWidgetState(ackSequence);
  }, [ackSequence]);
  return message ? <DictationWidget snapshot={message} /> : null;
}
