/**
 * The phone composer row, drawn after the native mobile app's
 * `ComposerDictationControl`: while recording, the toolbar turns into
 * cancel, waveform and time, and a round confirm. The mode button is the
 * phone's stand-in for Alt+S, Alt+I and Alt+Enter.
 */
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, MicIcon, PlusIcon, XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { CenterOutWaveform } from "~/symmetria/CenterOutWaveform";
import { MaterialDictationModeIcon } from "~/symmetria/MaterialDictationModeIcon";
import {
  cancelRecording,
  cycleDeliveryMode,
  finishRecording,
  recordedMsAt,
  requestSend,
  startRecording,
  usePrototypeStore,
  type DeliveryMode,
} from "./prototypeStore";

const PHONE_QUERY = "(max-width: 767px)";

export function usePhoneLayout(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(PHONE_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

const MODE_LABEL: Record<DeliveryMode, string> = {
  clipboard: "Save",
  inject: "Insert",
  submit: "Send",
};

/** A 44px touch target, like the native `VoiceActionButton`. */
function TouchButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className="flex size-11 shrink-0 items-center justify-center text-muted-foreground active:opacity-70"
    >
      {props.children}
    </button>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function PhoneToolbar(props: { threadId: string }) {
  const recording = usePrototypeStore((state) => state.recording);

  if (recording) {
    return (
      <div className="flex items-center px-1 pb-1">
        <TouchButton label="Cancel dictation" onClick={cancelRecording}>
          <XIcon className="size-5" />
        </TouchButton>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <div className="min-w-0 flex-1">
            <CenterOutWaveform
              sessionId={recording.sessionId}
              phase="recording"
              audioLevel={recording.level}
              active
              reducedMotion={false}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatElapsed(recordedMsAt(recording, Date.now()))}
          </span>
        </div>
        <button
          type="button"
          aria-label={`Delivery mode: ${MODE_LABEL[recording.mode]}. Tap to change.`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={cycleDeliveryMode}
          className="flex h-11 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-foreground active:opacity-70"
        >
          <MaterialDictationModeIcon mode={recording.mode} className="size-4" />
          {MODE_LABEL[recording.mode]}
        </button>
        <button
          type="button"
          aria-label="Stop and transcribe"
          onPointerDown={(event) => event.preventDefault()}
          onClick={finishRecording}
          className="flex size-11 shrink-0 items-center justify-center active:opacity-70"
        >
          <span className="flex size-7.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-4" strokeWidth={2.5} />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-1 pb-1">
      <TouchButton label="Attach" onClick={() => undefined}>
        <PlusIcon className="size-5" />
      </TouchButton>
      <span className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground">
        Opus 5.5 <ChevronDownIcon className="size-3" />
      </span>
      <span className="flex-1" />
      <TouchButton label="Start dictation" onClick={startRecording}>
        <MicIcon className="size-5" />
      </TouchButton>
      <button
        type="button"
        aria-label="Send"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => requestSend(props.threadId)}
        className="mr-1.5 flex size-8 items-center justify-center rounded-full bg-message-action text-message-action-foreground"
      >
        <ArrowUpIcon className="size-4" />
      </button>
    </div>
  );
}
