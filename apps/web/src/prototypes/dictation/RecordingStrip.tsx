import {
  CornerDownLeftIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SaveIcon,
  TextCursorInputIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ComposerBanner } from "~/components/chat/ComposerBanner";
import { cn } from "~/lib/utils";
import { CenterOutWaveform } from "~/symmetria/CenterOutWaveform";
import { Hint } from "./Hint";
import {
  cancelRecording,
  finishRecording,
  recordedMsAt,
  restartRecording,
  setActiveThread,
  togglePause,
  usePrototypeStore,
} from "./prototypeStore";

export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

function StripButton(props: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  destructive?: boolean;
}) {
  return (
    <Hint label={props.label}>
      <button
        type="button"
        aria-label={props.label}
        onClick={props.onClick}
        className={cn(
          "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
          props.destructive && "hover:text-destructive-foreground",
        )}
      >
        {props.children}
      </button>
    </Hint>
  );
}

/** One of the three ways to end a recording, with its key on desktop. */
function FinishButton(props: {
  label: string;
  keyHint: string;
  icon: ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium",
        props.primary
          ? "bg-primary/15 text-primary hover:bg-primary/25"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {props.icon}
      <span>{props.label}</span>
      <kbd className="hidden font-mono text-[10px] opacity-60 md:inline">{props.keyHint}</kbd>
    </button>
  );
}

/**
 * The recording is global: the strip shows on every thread, and names the
 * target when it is not the thread on screen.
 */
export function RecordingStrip(props: { displayedThreadId: string }) {
  const recording = usePrototypeStore((state) => state.recording);
  const targetTitle = usePrototypeStore(
    (state) => state.threads.find((thread) => thread.id === state.recording?.threadId)?.title,
  );
  const stopMode = usePrototypeStore((state) => state.stopMode);
  if (!recording) return null;
  const paused = recording.runningSince === null;
  const elsewhere = recording.threadId !== props.displayedThreadId;

  return (
    <ComposerBanner.Attachment className="pointer-events-auto relative z-0">
      <ComposerBanner.Root role="group" aria-label="Recording">
        <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-2">
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-secondary-label tabular-nums">
            <span
              className={cn(
                "size-1.5 rounded-full",
                paused ? "bg-muted-foreground" : "dictation-rec-dot bg-red-500",
              )}
            />
            {formatClock(recordedMsAt(recording, Date.now()))}
          </span>
          <div className="min-w-16 flex-1">
            <CenterOutWaveform
              sessionId={recording.jobId}
              phase={paused ? "paused" : "recording"}
              audioLevel={recording.level}
              active
              reducedMotion={false}
            />
          </div>
          {elsewhere ? (
            <Hint label="Recording into another thread. Go there.">
              <button
                type="button"
                className="max-w-36 truncate rounded-md px-1.5 py-0.5 text-[11px] text-primary hover:bg-accent"
                onClick={() => setActiveThread(recording.threadId)}
              >
                → {targetTitle}
              </button>
            </Hint>
          ) : null}
          <div className="flex items-center gap-0.5">
            <StripButton
              label={paused ? "Resume (Alt+Space)" : "Pause (Alt+Space)"}
              onClick={togglePause}
            >
              {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
            </StripButton>
            <StripButton label="Restart (Alt+R)" onClick={restartRecording}>
              <RotateCcwIcon className="size-3.5" />
            </StripButton>
            <StripButton label="Cancel (Alt+X)" destructive onClick={cancelRecording}>
              <XIcon className="size-3.5" />
            </StripButton>
          </div>
          <div className="flex items-center gap-0.5 md:border-l md:border-border/60 md:pl-1.5">
            <FinishButton
              label="Insert"
              keyHint="Alt+I"
              icon={<TextCursorInputIcon className="size-3.5" />}
              primary={stopMode === "inject"}
              onClick={() => finishRecording("inject")}
            />
            <FinishButton
              label="Send"
              keyHint="Alt+↵"
              icon={<CornerDownLeftIcon className="size-3.5" />}
              primary={stopMode === "submit"}
              onClick={() => finishRecording("submit")}
            />
            <FinishButton
              label="Save"
              keyHint="Alt+S"
              icon={<SaveIcon className="size-3.5" />}
              onClick={() => finishRecording("save")}
            />
          </div>
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
