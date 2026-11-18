import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type PointerEvent, type RefObject } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useDictationJobs } from "~/state/dictation";
import { useMicrophoneBlocker } from "../voice/microphoneClaim";
import {
  cancelFieldDictation,
  cancelQueuedFieldSubmit,
  deliverFieldDictationJobs,
  insertTranscriptAtCaret,
  isFieldDictationBusy,
  queueFieldSubmit,
  startFieldDictation,
  stopFieldDictation,
  takeQueuedFieldSubmit,
  useFieldDictationStore,
} from "./fieldDictation";

/** Mesura dictation bound to one plain-textarea editor; see `fieldDictation.ts`. */
export function useFieldDictation(input: {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly text: string;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly onTextChange: (text: string) => void;
  readonly disabled?: boolean | undefined;
}) {
  const { environmentId, ownerKey } = input;
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed field callbacks to transcripts that land later
  useEffect(() => {
    latest.current = input;
  });
  const phase = useFieldDictationStore((state) =>
    state.recording?.ownerKey === ownerKey ? state.recording.phase : null,
  );
  const busy = useFieldDictationStore((state) => isFieldDictationBusy(state, ownerKey));
  const failedPending = useFieldDictationStore((state) =>
    (state.pending[ownerKey] ?? []).some((jobId) => state.failed.has(jobId)),
  );
  const pending = useFieldDictationStore((state) => state.pending[ownerKey]?.length ?? 0);
  const submitQueued = useFieldDictationStore((state) => state.submitQueued.has(ownerKey));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an editor that closes mid-recording transcribes it, so no hidden recording holds the microphone
  useEffect(
    () => () => {
      if (useFieldDictationStore.getState().recording?.ownerKey === ownerKey) {
        void stopFieldDictation();
      }
    },
    [ownerKey],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an editor that can no longer submit, such as a hidden form, ends its recording
  useEffect(() => {
    if (input.disabled && useFieldDictationStore.getState().recording?.ownerKey === ownerKey) {
      void stopFieldDictation();
    }
  }, [input.disabled, ownerKey]);

  const { jobs, loaded } = useDictationJobs(pending > 0 ? environmentId : null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- inserts transcripts as the server's job subscription reports them
  useEffect(() => {
    if (!loaded || pending === 0) return;
    deliverFieldDictationJobs({
      ownerKey,
      environmentId,
      jobs,
      insert: (transcripts) => {
        const field = latest.current.textareaRef.current;
        // At the caret of a focused field, else at the end; a late transcript never takes focus.
        const focused = field !== null && document.activeElement === field;
        let next = {
          text: latest.current.text,
          caret: focused ? field.selectionStart : latest.current.text.length,
        };
        for (const transcript of transcripts) {
          next = insertTranscriptAtCaret(next.text, next.caret, transcript);
        }
        // Read by a submission that runs before the editor re-renders with the text.
        latest.current = { ...latest.current, text: next.text };
        latest.current.onTextChange(next.text);
        if (focused) {
          window.requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
        }
      },
    });
  }, [environmentId, jobs, loaded, ownerKey, pending]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends a held submission once the last transcript is in the draft, or drops it when one failed
  useEffect(() => {
    if (!submitQueued) return;
    if (failedPending) cancelQueuedFieldSubmit(ownerKey);
    else if (!busy) {
      const submit = takeQueuedFieldSubmit(ownerKey);
      if (submit && !latest.current.disabled) submit(latest.current.text);
    }
  }, [busy, failedPending, ownerKey, submitQueued]);

  /** Holds `submit` until the recording and its transcript are in the draft; stops a recording. */
  const submitWhenTranscribed = (submit: (text: string) => void) => {
    queueFieldSubmit(ownerKey, submit);
    if (useFieldDictationStore.getState().recording?.ownerKey === ownerKey) {
      void stopFieldDictation();
    }
  };

  return {
    environmentId,
    ownerKey,
    phase,
    busy,
    transcribing: busy && phase === null,
    submitQueued,
    submitWhenTranscribed,
    cancelQueuedSubmit: () => cancelQueuedFieldSubmit(ownerKey),
  };
}

type FieldDictation = ReturnType<typeof useFieldDictation>;

const keepFocus = (event: PointerEvent) => event.preventDefault();

function IconButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            aria-disabled={props.disabled === true}
            inactive={props.disabled === true}
            onPointerDown={keepFocus}
            onClick={() => {
              if (!props.disabled) props.onClick();
            }}
            className="shrink-0"
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

/** One microphone per editor: start, then Stop and Cancel while it records. */
export function FieldDictationControls(props: {
  readonly dictation: FieldDictation;
  readonly disabled?: boolean;
}) {
  const { dictation } = props;
  const blocker = useMicrophoneBlocker("field");
  const recordingElsewhere = useFieldDictationStore(
    (state) => state.recording !== null && state.recording.ownerKey !== dictation.ownerKey,
  );
  if (dictation.phase !== null) {
    return (
      <>
        <span className="shrink-0 text-xs text-muted-foreground">
          {dictation.phase === "opening" ? "Starting…" : "Recording"}
        </span>
        <IconButton label="Stop and transcribe" onClick={() => void stopFieldDictation()}>
          <SquareIcon className="fill-current" />
        </IconButton>
        <IconButton label="Cancel dictation" onClick={cancelFieldDictation}>
          <XIcon />
        </IconButton>
      </>
    );
  }
  const unavailable = props.disabled === true || blocker !== null || recordingElsewhere;
  return (
    <>
      {dictation.transcribing ? (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          {dictation.submitQueued ? "Sends when transcribed" : "Transcribing…"}
        </span>
      ) : null}
      {dictation.submitQueued ? (
        <IconButton
          label="Don't send when the transcription lands"
          onClick={dictation.cancelQueuedSubmit}
        >
          <XIcon />
        </IconButton>
      ) : null}
      <IconButton
        label={
          recordingElsewhere
            ? "Another comment is being dictated"
            : (blocker ?? "Start voice dictation")
        }
        disabled={unavailable}
        onClick={() => void startFieldDictation(dictation.ownerKey, dictation.environmentId)}
      >
        <MicIcon />
      </IconButton>
    </>
  );
}
