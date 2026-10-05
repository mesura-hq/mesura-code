import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  cancelDictation,
  cycleDictationMode,
  restartDictation,
  startDictation,
  stopDictation,
  toggleDictationPause,
} from "./dictationController";
import { useDictationSessionStore } from "./dictationSessionStore";
import { DictationStripBanner, type DictationStripAction } from "./DictationStripBanner";
import { useQuestionSendWhenReady } from "./questionSendWhenReady";
import { prefersReducedMotion } from "./reducedMotion";
import { useDesktopDictationBridge } from "./useDesktopDictationBridge";
import {
  useDictationDelivery,
  useDictationKeybindings,
  useDictationEnvironments,
} from "./useDictationSession";

/**
 * A microphone that starts a recording in this window: the composer's, or a question card's when
 * `targetLabel` names the answer and `onBeforeStart` makes that answer the marker's target.
 */
export const DictationStartButton = memo(function DictationStartButton(props: {
  readonly targetLabel?: string;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly onBeforeStart?: () => void;
}) {
  const recording = useDictationSessionStore((state) => state.session !== null);
  const unavailable = recording || props.disabled === true;
  const label = recording
    ? "A dictation session is already active"
    : props.disabled
      ? "Voice input is unavailable while this answer is sending"
      : props.targetLabel
        ? `Dictate into ${props.targetLabel}`
        : "Start voice dictation";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-disabled={unavailable}
            aria-label={label}
            className={cn(
              "rounded-full text-secondary-label transition-colors",
              props.compact && "size-7 rounded-md text-muted-foreground",
              unavailable && "cursor-default opacity-45",
            )}
            onClick={() => {
              if (unavailable) return;
              props.onBeforeStart?.();
              void startDictation();
            }}
          >
            <MicIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {label}
      </TooltipPopup>
    </Tooltip>
  );
});

const STRIP_CONTROLS: Record<DictationStripAction, () => void> = {
  pause: toggleDictationPause,
  resume: toggleDictationPause,
  restart: () => void restartDictation(),
  cancel: cancelDictation,
  stop: () => void stopDictation(),
};

/** The shipped strip, shown while this window records. It goes away when recording stops. */
export const DictationRecordingStrip = memo(function DictationRecordingStrip() {
  const session = useDictationSessionStore((state) => state.session);
  if (!session) return null;
  return (
    <DictationStripBanner
      session={session}
      reducedMotion={prefersReducedMotion()}
      onControl={(action) => STRIP_CONTROLS[action]()}
      onChangeMode={cycleDictationMode}
    />
  );
});

function DictationEnvironmentDelivery({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  useDictationDelivery(environmentId);
  return null;
}

/**
 * Mounted once for the whole app: places this client's transcripts into whichever draft holds
 * their marker, on screen or not, answers armed question cards, listens for the dictation
 * keys, and on the desktop takes the `--dictation …` command line and feeds the widget.
 */
export function DictationJobDelivery() {
  useDictationKeybindings();
  useDesktopDictationBridge();
  useQuestionSendWhenReady();
  return useDictationEnvironments().map((environmentId) => (
    <DictationEnvironmentDelivery key={environmentId} environmentId={environmentId} />
  ));
}
