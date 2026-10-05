import { PauseIcon, PlayIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { ComposerBanner } from "~/components/chat/ComposerBanner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { CenterOutWaveform } from "./CenterOutWaveform";
import {
  dictationPhaseLabel,
  dictationRecordedElapsedMs,
  dictationRecordingPhase,
  formatDictationElapsed,
} from "./dictationPresentation";
import type { DictationRecordingSession } from "./dictationSessionStore";
import { MaterialDictationModeIcon } from "./MaterialDictationModeIcon";

export type DictationStripAction = "pause" | "resume" | "restart" | "cancel" | "stop";

const StripButton = memo(function StripButton(props: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  destructive?: boolean;
  modeControl?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            data-dictation-mode-control={props.modeControl ? "true" : undefined}
            data-dictation-control="true"
            // Keeps the composer's focus and caret: Stop drops the marker where the caret is.
            onMouseDown={(event) => event.preventDefault()}
            className={cn(
              "flex size-7 cursor-pointer items-center justify-center rounded-full border border-border/55 bg-background/35 text-secondary-label shadow-xs backdrop-blur-md transition-[color,background-color,border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:scale-[1.06] hover:border-foreground/20 hover:bg-foreground/10 hover:text-foreground hover:shadow-sm focus-visible:border-foreground/25 focus-visible:ring-2 focus-visible:ring-foreground/20 focus-visible:outline-none active:translate-y-0 active:scale-95",
              props.destructive &&
                "hover:border-destructive/30 hover:bg-destructive/12 hover:text-destructive",
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

/** The recording strip: timer, waveform, and the round pause, restart, cancel, stop and mode controls. */
export const DictationStripBanner = memo(function DictationStripBanner(props: {
  session: DictationRecordingSession;
  reducedMotion: boolean;
  onControl: (action: DictationStripAction) => void;
  onChangeMode: () => void;
}) {
  const { session, reducedMotion, onControl, onChangeMode } = props;
  const phase = dictationRecordingPhase(session);
  const mode = session.mode;

  // Attached composer banner, never a hand-styled surface — the dictation
  // strip block in mesura.css records why. Placement contract: the strip must
  // render as a direct child of the composer's `ComposerBanner.Column`
  // (ChatComposer's `dictationStrip` prop). There it joins the banner stack,
  // and the Dock's side tabs such as Stash sit beside it. Rendered above the
  // form instead, it fused onto the Dock and left the Stash tab hanging below
  // it as a separate step. Column's child selectors (`w-full`,
  // `last-child:mb-0`) match only a direct `composer-banner-attachment`
  // child, so do not wrap the strip, and keep it last. Inside the form, the
  // collapsed-controls marker stops a click on the strip from expanding a
  // resting composer.
  return (
    <ComposerBanner.Attachment
      className="mesura-dictation-strip pointer-events-auto relative z-0"
      data-chat-composer-collapsed-controls="true"
      data-phase={phase}
    >
      <ComposerBanner.Root
        role="group"
        aria-label={`Voice dictation: ${dictationPhaseLabel(phase)}`}
      >
        <div className="flex min-h-7 items-center gap-2 px-2">
          <span className="w-12 shrink-0 font-mono text-[11px] text-secondary-label tabular-nums @max-[280px]:hidden">
            {formatDictationElapsed(dictationRecordedElapsedMs(session))}
          </span>
          <CenterOutWaveform
            key={session.sessionId}
            sessionId={session.sessionId}
            phase={phase}
            audioLevel={session.level}
            active
            reducedMotion={reducedMotion}
          />
          <span className="sr-only" role="status">
            {dictationPhaseLabel(phase)}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <StripButton
              label={phase === "paused" ? "Resume recording" : "Pause recording"}
              onClick={() => onControl(phase === "paused" ? "resume" : "pause")}
            >
              {phase === "paused" ? (
                <PlayIcon className="size-3.5" />
              ) : (
                <PauseIcon className="size-3.5" />
              )}
            </StripButton>
            <StripButton label="Restart recording" onClick={() => onControl("restart")}>
              <RotateCcwIcon className="size-3.5" />
            </StripButton>
            <StripButton label="Cancel dictation" destructive onClick={() => onControl("cancel")}>
              <XIcon className="size-3.5" />
            </StripButton>
            <StripButton label="Stop and transcribe" onClick={() => onControl("stop")}>
              <SquareIcon className="size-3" />
            </StripButton>
            <StripButton label={`Delivery mode: ${mode}`} modeControl onClick={onChangeMode}>
              <MaterialDictationModeIcon mode={mode} className="size-3.5" />
            </StripButton>
          </div>
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
