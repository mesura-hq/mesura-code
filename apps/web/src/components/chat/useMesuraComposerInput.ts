import {
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import { registerDictationSlotFillHandler } from "../../composerDraftStore";
import { fillDictationSlotKeepingCaret } from "../../dictation/dictationSlotEdits";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { registerComposerVimAdapter } from "../../keys/composer/composerSurface";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import type { ChatComposerHandle } from "./ChatComposer";
import { useStableCallback } from "../../hooks/useStableCallback";

/** Registers the fork's editor protocols against the upstream composer editor. */
export function useMesuraComposerInput(input: {
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerDraftTargetKeyRef: RefObject<string>;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly promptRef: RefObject<string>;
  readonly setPrompt: (prompt: string) => void;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly readComposerSnapshot: () => { expandedCursor: number };
  readonly applyPromptReplacement: (
    start: number,
    end: number,
    text: string,
    options?: { focusEditorAfterReplace?: boolean },
  ) => boolean;
}) {
  const {
    composerDraftTarget,
    composerDraftTargetKeyRef,
    composerEditorRef,
    composerRef,
    promptRef,
    setComposerCursor,
    readComposerSnapshot,
    applyPromptReplacement,
  } = input;
  const setPrompt = useStableCallback(input.setPrompt);
  useEffect(
    () =>
      registerComposerVimAdapter({
        read: () => ({
          prompt: promptRef.current,
          cursor: composerEditorRef.current?.readSnapshot().cursor ?? promptRef.current.length,
        }),
        write: (prompt, cursor) => {
          applyPromptReplacement(0, promptRef.current.length, prompt, {
            focusEditorAfterReplace: false,
          });
          window.requestAnimationFrame(() => composerEditorRef.current?.focusAt(cursor));
        },
        setCursor: (cursor) => composerRef.current?.focusAt(cursor),
        draftKey: () => composerDraftTargetKeyRef.current,
      }),
    [applyPromptReplacement, composerDraftTargetKeyRef, composerEditorRef, composerRef, promptRef],
  );
  // Several fills can arrive before the editor commits. The last fill owns the caret until then.
  const lastFillRef = useRef<{ prompt: string; expandedCursor: number } | null>(null);
  useLayoutEffect(() => {
    lastFillRef.current = null;
  });
  useEffect(
    () =>
      registerDictationSlotFillHandler(composerDraftTarget, (jobId, transcript) => {
        const last = lastFillRef.current;
        const filled = fillDictationSlotKeepingCaret(
          promptRef.current,
          last?.prompt === promptRef.current
            ? last.expandedCursor
            : readComposerSnapshot().expandedCursor,
          jobId,
          transcript,
        );
        if ("missing" in filled) return "missing";
        lastFillRef.current = { prompt: filled.text, expandedCursor: filled.expandedCursor };
        promptRef.current = filled.text;
        setPrompt(filled.text);
        setComposerCursor(collapseExpandedComposerCursor(filled.text, filled.expandedCursor));
        return "filled";
      }),
    [composerDraftTarget, promptRef, readComposerSnapshot, setComposerCursor, setPrompt],
  );
}
