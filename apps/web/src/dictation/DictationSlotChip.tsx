import type { DictationTarget } from "@t3tools/contracts";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { use } from "react";

import { ComposerContextActionsContext } from "~/components/composerContextPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useDictationJobs } from "~/state/dictation";
import { MaterialDictationModeIcon } from "./MaterialDictationModeIcon";
import {
  discardDictationJob,
  retryDictationJob,
  toComposerThreadTarget,
} from "./dictationController";
import { useOwnDictationJobsStore } from "./dictationSessionStore";
import { disarmSendWhenReady, useSendWhenReadyArmed } from "./sendWhenReady";

const WAVE_BARS = [0, 1, 2, 3, 4, 5] as const;

/**
 * A `dictation` link in the composer: caret, wave and mode, or Retry and Discard once it failed.
 * The mode is this device's own choice (the server's copy lags); an armed draft shows the send
 * glyph as a button that keeps it unsent. `inert` drops the buttons, for a preview that is one.
 */
export function DictationSlotChip(props: { readonly jobId: string; readonly inert?: boolean }) {
  const own = useOwnDictationJobsStore((state) => state.jobs[props.jobId]);
  const composer = use(ComposerContextActionsContext);
  const { jobs } = useDictationJobs(own?.environmentId ?? composer.environmentId);
  const job = jobs.find((candidate) => candidate.id === props.jobId);
  const draftTarget = own?.question ? null : (own?.target ?? job?.target ?? null);
  const armed = useSendWhenReadyArmed(draftTarget ? toComposerThreadTarget(draftTarget) : null);
  const sendGlyph =
    armed && draftTarget && !props.inert ? (
      <CancelSendWhenReadyButton target={draftTarget} />
    ) : null;

  // A job that never reached the server fails here too, so its marker can be retried.
  if (job?.status === "failed" || own?.notStarted !== undefined) {
    return (
      <span
        contentEditable={false}
        className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-px align-baseline text-search-label text-destructive-foreground select-none"
      >
        transcription failed
        {sendGlyph}
        {/* Retry and Discard act on this device's jobs; another device owns its own. */}
        {own && !props.inert ? (
          <>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-destructive/20"
              aria-label="Retry transcription"
              onClick={() => retryDictationJob(props.jobId)}
            >
              <RotateCcwIcon className="size-3" />
            </button>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-destructive/20"
              aria-label="Discard transcription marker"
              onClick={() => discardDictationJob(props.jobId)}
            >
              <XIcon className="size-3" />
            </button>
          </>
        ) : null}
      </span>
    );
  }

  return (
    <span
      contentEditable={false}
      className="dictation-slot mx-0.5 h-[1.4em] items-center gap-1 rounded-sm px-0.5 align-middle text-search-label leading-none text-primary select-none"
    >
      <span className="dictation-slot-caret h-[1.5em] w-[2px] rounded-full bg-primary" />
      <span
        role="img"
        aria-label="Transcribing"
        className="dictation-slot-wave h-[1em] items-center gap-0.5"
      >
        {WAVE_BARS.map((bar) => (
          <span key={bar} className="block h-full w-[2px] rounded-full bg-primary/80" />
        ))}
      </span>
      {sendGlyph ?? (
        <MaterialDictationModeIcon
          mode={own?.mode ?? job?.mode ?? "submit"}
          className="size-3 opacity-70"
        />
      )}
    </span>
  );
}

function CancelSendWhenReadyButton(props: { readonly target: Exclude<DictationTarget, null> }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Don't send when the transcription lands"
            // Keeps focus in the editor: on a phone, a composer that loses focus collapses.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => disarmSendWhenReady(toComposerThreadTarget(props.target))}
            className="relative inline-flex rounded-sm opacity-70 after:absolute after:-inset-2 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-primary"
          />
        }
      >
        <MaterialDictationModeIcon mode="submit" className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>Sends when the transcription lands. Press to keep it unsent.</TooltipPopup>
    </Tooltip>
  );
}
