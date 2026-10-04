import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { CenterOutWaveform } from "~/symmetria/CenterOutWaveform";
import { formatDictationElapsed } from "~/symmetria/dictationPresentation";
import { MaterialDictationModeIcon } from "~/symmetria/MaterialDictationModeIcon";
import { recordedDictationMs } from "./dictationSessionStore";
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
    const paused = session.runningSince === null;
    body = (
      <>
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            paused ? "bg-zinc-500" : "dictation-widget-rec-dot bg-red-500",
          )}
        />
        <span className="font-mono text-xs tabular-nums text-zinc-300">
          {formatDictationElapsed(recordedDictationMs(session, session.sampledAt))}
        </span>
        <div className="flex w-28">
          <CenterOutWaveform
            sessionId={session.sessionId}
            phase={paused ? "paused" : "recording"}
            audioLevel={session.level}
            active
            reducedMotion={prefersReducedMotion()}
            className="text-zinc-200"
          />
        </div>
        <MaterialDictationModeIcon mode={session.mode} className="size-4 shrink-0 text-zinc-300" />
        {target ? (
          <span className="max-w-36 truncate text-xs text-zinc-400">→ {target}</span>
        ) : null}
        {snapshot.transcribingCount > 0 ? (
          <span className="shrink-0 text-[11px] text-sky-300">
            +{snapshot.transcribingCount} transcribing
          </span>
        ) : null}
      </>
    );
  } else if (snapshot.failed) {
    // Shown until Mesura has focus: the user in another app must not assume it went out.
    body = (
      <span className="truncate text-xs text-red-300">
        {snapshot.failed.target
          ? `Transcription failed in ${snapshot.failed.target}. Open Mesura to retry.`
          : "Transcription failed. Open Mesura to retry."}
      </span>
    );
  } else if (snapshot.transcribing) {
    body = (
      <>
        {mode ? (
          <MaterialDictationModeIcon mode={mode} className="size-4 shrink-0 text-sky-300" />
        ) : null}
        <span className="dictation-widget-transcribing truncate text-xs text-sky-300">
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
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-emerald-400">
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
        className="flex h-11 max-w-full items-center gap-2.5 rounded-full border border-white/10 bg-zinc-900/90 px-4 shadow-xl"
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
  useEffect(
    () => window.mesuraDictationBridge?.onWidgetState((raw) => setMessage(parseMessage(raw))),
    [],
  );
  const ackSequence = message?.ackSequence;
  useEffect(() => {
    if (ackSequence !== undefined)
      window.mesuraDictationBridge?.acknowledgeWidgetState(ackSequence);
  }, [ackSequence]);
  return message ? <DictationWidget snapshot={message} /> : null;
}
