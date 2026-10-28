import type { DictationMode, ScopedThreadRef } from "@t3tools/contracts";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { stopDictation } from "./dictationController";
import { useDictationSessionStore } from "./dictationSessionStore";
import { useThreadDictationActivity } from "./threadDictationActivity";
import { SidebarDictationWaveform } from "./SidebarDictationWaveform";

const STOP_LABELS: Record<DictationMode, string> = {
  submit: "Stop recording and send it in this thread",
  inject: "Stop recording and insert it in this thread",
  clipboard: "Stop recording and copy the transcript",
};

/** The thread's stop button or transcription mark, at the title row's right edge.
 * Visible bars sample at 10 Hz outside React; only transforms and opacity transition.
 * Hidden, paused and reduced-motion bars stop sampling to limit GPU work.
 */
export const SidebarDictationIndicator = memo(function SidebarDictationIndicator(props: {
  readonly threadRef: ScopedThreadRef;
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
                "inline-flex shrink-0 items-center text-foreground opacity-70 pointer-coarse:size-11 pointer-coarse:justify-center",
                props.className,
              )}
            />
          }
        >
          <SidebarDictationWaveform recording={false} />
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
              "relative inline-flex shrink-0 cursor-pointer items-center rounded-sm text-foreground outline-none pointer-coarse:size-11 pointer-coarse:justify-center hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-1/2",
              props.className,
            )}
          />
        }
      >
        <SidebarDictationWaveform recording />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});
