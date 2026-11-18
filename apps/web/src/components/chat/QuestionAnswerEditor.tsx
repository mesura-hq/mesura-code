import { useImperativeHandle, useRef, useState, type ClipboardEvent, type Ref } from "react";

import { cn } from "~/lib/utils";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";

/** What a question card needs from its answer field: focus, the caret, and whether it is live. */
export interface QuestionAnswerFieldHandle {
  readonly focus: () => void;
  /** The caret as an offset into the answer text, markers counted by their full link text. */
  readonly caret: () => number;
  readonly isConnected: () => boolean;
  readonly disabled: boolean;
  readonly element: () => HTMLElement | null;
}

const NO_SKILLS: never[] = [];

/**
 * A question card's answer, edited in the composer's editor without rich text so a dictation
 * marker draws as its chip. A plain textarea can only show the marker's link text.
 */
export function QuestionAnswerEditor(props: {
  readonly value: string;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly invalid: boolean;
  readonly onChange: (text: string) => void;
  readonly onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  readonly handleRef: Ref<QuestionAnswerFieldHandle>;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(props.value.length);
  useImperativeHandle(
    props.handleRef,
    () => ({
      focus: () => editorRef.current?.focus(),
      caret: () => editorRef.current?.readSnapshot().expandedCursor ?? props.value.length,
      isConnected: () => containerRef.current?.isConnected ?? false,
      disabled: props.disabled,
      element: () => containerRef.current,
    }),
    [props.disabled, props.value.length],
  );
  return (
    <div
      ref={containerRef}
      className={cn(
        "min-h-18 w-full rounded-lg border bg-background px-3 py-2 text-sm leading-6 focus-within:border-primary focus-within:ring-1 focus-within:ring-inset focus-within:ring-primary/30",
        props.invalid ? "border-destructive" : "border-border",
        props.disabled && "opacity-50",
      )}
    >
      <ComposerPromptEditorTiptap
        ariaLabel={props.ariaLabel}
        editorTestId="question-answer-editor"
        editorRef={editorRef}
        value={props.value}
        cursor={cursor}
        contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
        skills={NO_SKILLS}
        disabled={props.disabled}
        placeholder={props.placeholder}
        className="max-h-60"
        onChange={(nextValue, nextCursor) => {
          setCursor(nextCursor);
          if (nextValue !== props.value) props.onChange(nextValue);
        }}
        onPaste={props.onPaste}
      />
    </div>
  );
}
