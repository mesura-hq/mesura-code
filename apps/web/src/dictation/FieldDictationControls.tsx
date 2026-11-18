import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type PointerEvent, type RefObject } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useDictationJobs } from "~/state/dictation";
import { useMicrophoneBlocker } from "../voice/microphoneClaim";
import {
  cancelFieldDictation,
  deliverFieldDictationJobs,
  insertTranscriptAtCaret,
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
}) {
  const { environmentId, ownerKey } = input;
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed field callbacks to transcripts that land later
  useEffect(() => {
    latest.current = input;
  });
  const recordingHere = useFieldDictationStore((state) => state.recording?.ownerKey === ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an editor that closes mid-recording transcribes it, so no hidden recording holds the microphone
  useEffect(
    () => () => {
      if (useFieldDictationStore.getState().recording?.ownerKey === ownerKey) {
        void stopFieldDictation();
      }
    },
    [ownerKey],
  );
  const pending = useFieldDictationStore((state) => state.pending[ownerKey]?.length ?? 0);
  const { jobs, loaded } = useDictationJobs(pending > 0 ? environmentId : null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- inserts transcripts as the server's job subscription reports them
  useEffect(() => {
    if (!loaded || pending === 0) return;
    deliverFieldDictationJobs({
      ownerKey,
      environmentId,
      jobs,
      insert: (transcript) => {
        const field = latest.current.textareaRef.current;
        const text = latest.current.text;
        // At the caret of a focused field, else at the end; a late transcript never takes focus.
        const focused = field !== null && document.activeElement === field;
        const caret = focused ? field.selectionStart : text.length;
        const next = insertTranscriptAtCaret(text, caret, transcript);
        latest.current.onTextChange(next.text);
        if (focused) {
          window.requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
        }
      },
    });
  }, [environmentId, jobs, loaded, ownerKey, pending]);
  return { environmentId, ownerKey, recordingHere, transcribing: pending > 0 };
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
            aria-disabled={props.disabled}
            inactive={props.disabled}
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
  if (dictation.recordingHere) {
    return (
      <>
        <span className="shrink-0 text-xs text-muted-foreground">Recording</span>
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
          Transcribing…
        </span>
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
