import type { DictationMode, ScopedThreadRef } from "@t3tools/contracts";
import { AudioLinesIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { stopDictation } from "./dictationController";
import { useDictationSessionStore } from "./dictationSessionStore";
import { useThreadDictationActivity } from "./threadDictationActivity";

const STOP_LABELS: Record<DictationMode, string> = {
  submit: "Stop recording and send it in this thread",
  inject: "Stop recording and insert it in this thread",
  clipboard: "Stop recording and copy the transcript",
};

/**
 * The sound wave beside a thread's title while this device records into the thread, or its
 * transcription is on the way. While recording it is the stop button: the transcript goes to
 * this thread in the recording's mode, whichever thread is on screen. It holds still, because
 * a continuously animated mark in every list repaints the GPU for as long as the recording runs.
 */
export const SidebarDictationIndicator = memo(function SidebarDictationIndicator(props: {
  readonly threadRef: ScopedThreadRef;
  /** Spacing from the title, where the row's own gap does not give it. */
  readonly className?: string;
}) {
  const activity = useThreadDictationActivity(props.threadRef);
  const mode = useDictationSessionStore((state) => state.session?.mode ?? null);
  if (activity === null) return null;
  if (activity === "transcribing" || mode === null) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label="Transcribing dictation"
              className={cn(
                "inline-flex shrink-0 items-center text-muted-foreground",
                props.className,
              )}
            />
          }
        >
          <AudioLinesIcon aria-hidden className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Transcribing dictation</TooltipPopup>
      </Tooltip>
    );
  }
  const label = STOP_LABELS[mode];
  // The row opens the thread on click and renames it on double click; this button does neither.
  const stopRowGesture = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={(event) => {
              stopRowGesture(event);
              void stopDictation();
            }}
            onDoubleClick={stopRowGesture}
            className={cn(
              "relative inline-flex shrink-0 cursor-pointer items-center rounded-sm text-destructive-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-1/2",
              props.className,
            )}
          />
        }
      >
        <AudioLinesIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});
