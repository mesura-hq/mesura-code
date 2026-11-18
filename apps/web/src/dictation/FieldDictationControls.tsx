import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useDictationJobs } from "~/state/dictation";
import { useMicrophoneBlocker } from "../voice/microphoneClaim";
import {
  cancelFieldDictation,
  cancelQueuedFieldSubmit,
  deliverFieldDictationJobs,
  detachFieldDictation,
  insertTranscriptAtCaret,
  isFieldDictationBusy,
  queueFieldSubmit,
  startFieldDictation,
  stopFieldDictation,
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
  const { environmentId } = input;
  // One draft is one mount: two editors showing the same range, such as overlapping guide
  // excerpts, never share a recording, a job or a held submission.
  const [draftId] = useState(randomUUID);
  const ownerKey = JSON.stringify([input.ownerKey, draftId]);
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed field callbacks to transcripts that land later
  useEffect(() => {
    latest.current = input;
  });
  const phase = useFieldDictationStore((state) =>
    state.recording?.ownerKey === ownerKey ? state.recording.phase : null,
  );
  const busy = useFieldDictationStore((state) => isFieldDictationBusy(state, ownerKey));
  const pending = useFieldDictationStore((state) => state.pending[ownerKey]?.length ?? 0);
  const submitQueued = useFieldDictationStore((state) => state.submitQueued.has(ownerKey));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a closed editor's draft is gone: its recording and transcripts go to Transcriptions, never into a later draft
  useEffect(() => () => detachFieldDictation(ownerKey, environmentId), [environmentId, ownerKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a locked or hidden editor keeps its draft but cannot submit: its held submission is dropped and a recording ends
  useEffect(() => {
    if (!input.disabled) return;
    cancelQueuedFieldSubmit(ownerKey);
    if (useFieldDictationStore.getState().recording?.ownerKey === ownerKey) {
      void stopFieldDictation();
    }
  }, [input.disabled, ownerKey]);
  // Set by a manual submit; the post succeeded once the editor clears its draft.
  const endsWhenCleared = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a draft cleared after a manual submit was posted: a failed job's retry must not land in the next one
  useEffect(() => {
    if (!endsWhenCleared.current || input.text.trim() !== "") return;
    endsWhenCleared.current = false;
    detachFieldDictation(ownerKey, environmentId);
  }, [environmentId, input.text, ownerKey]);

  const { jobs, cursor, loaded } = useDictationJobs(pending > 0 ? environmentId : null);
  // A stamp that arrives after the list still has to be judged against it.
  const stamps = useFieldDictationStore((state) => state.stamps);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- inserts transcripts as the server's job subscription reports them, then runs a submission held for them
  useEffect(() => {
    if (!loaded || pending === 0) return;
    const submit = deliverFieldDictationJobs({
      ownerKey,
      environmentId,
      jobs,
      cursor,
      stamps,
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
        // Read by the held submission below, before the editor re-renders with the text.
        latest.current = { ...latest.current, text: next.text };
        latest.current.onTextChange(next.text);
        if (focused) {
          window.requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
        }
      },
    });
    if (submit && !latest.current.disabled) submit(latest.current.text);
  }, [cursor, environmentId, jobs, loaded, ownerKey, pending, stamps]);

  /** Holds `submit` until the recording and its transcript are in the draft; stops a recording. */
  const submitWhenTranscribed = (submit: (text: string) => void) => {
    const recording = useFieldDictationStore.getState().recording;
    if (recording?.ownerKey === ownerKey) {
      if (recording.phase === "opening") {
        toastManager.add({
          type: "info",
          title: "The microphone is still starting",
          description: "Stop or cancel the recording, then send.",
        });
        return;
      }
      void stopFieldDictation();
    }
    if (!queueFieldSubmit(ownerKey, submit)) submit(latest.current.text);
  };

  /**
   * A submission by hand ends the draft once it is posted, which an editor shows by clearing it
   * or closing. A failed post leaves the draft, so a transcription retry still lands in it.
   */
  const releaseDraft = () => {
    endsWhenCleared.current = true;
  };

  return {
    environmentId,
    ownerKey,
    phase,
    busy,
    transcribing: busy && phase === null,
    submitQueued,
    submitWhenTranscribed,
    releaseDraft,
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
        // Wraps rather than overflows in a narrow editor, such as a phone's Monaco comment.
        <span role="status" className="min-w-0 text-xs text-pretty text-muted-foreground">
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
