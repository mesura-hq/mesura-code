import type { RefObject } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cancelComposerNormalResume } from "../../keys/composer/composerSurface";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { isInsideRestingComposerControlScope } from "./composerEventScope";
import { useFileManagerStore } from "../files/mesuraFileManager/fileManagerStore";

/** Reveal a collapsed phone composer before restoring its caret and keyboard mode. */
export function useMesuraComposerFocus(input: {
  readonly isMobileViewport: boolean;
  readonly isComposerCollapsedMobile: boolean;
  readonly setIsComposerFocused: (focused: boolean) => void;
  readonly composerDraftTargetKeyRef: RefObject<string>;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly composerSurfaceRef: RefObject<HTMLElement | null>;
  readonly composerFormRef: RefObject<HTMLElement | null>;
  readonly composerBlurFrameRef: RefObject<number | null>;
  readonly mobileComposerExpandFrameRef: RefObject<number | null>;
  readonly mobileComposerExpandReleaseFrameRef: RefObject<number | null>;
  readonly mobileComposerExpandInFlightRef: RefObject<boolean>;
}) {
  const {
    isMobileViewport,
    isComposerCollapsedMobile,
    setIsComposerFocused,
    composerDraftTargetKeyRef,
    composerEditorRef,
    composerSurfaceRef,
    composerFormRef,
    composerBlurFrameRef,
    mobileComposerExpandFrameRef,
    mobileComposerExpandReleaseFrameRef,
    mobileComposerExpandInFlightRef,
  } = input;
  const scheduleComposerCollapseCheck = useStableCallback(() => {
    if (!isMobileViewport || mobileComposerExpandInFlightRef.current) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) return;
      const active = document.activeElement;
      if (
        isInsideRestingComposerControlScope(active) ||
        composerSurfaceRef.current?.contains(active) ||
        composerFormRef.current?.contains(active)
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  });
  const expandMobileComposerAt = useStableCallback((cursor?: number) => {
    const previousFocus = document.activeElement;
    const draftKey = composerDraftTargetKeyRef.current;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      const active = document.activeElement;
      const editor = composerSurfaceRef.current?.querySelector('[data-testid="composer-editor"]');
      // Expansion commits before this frame. A new owner or draft cancels the
      // old request; restoring focus unconditionally stole that owner's keyboard.
      if (
        composerDraftTargetKeyRef.current !== draftKey ||
        isCommandPaletteOpen() ||
        useFileManagerStore.getState().open ||
        document.querySelector(
          '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
        ) ||
        (active !== previousFocus && active !== document.body && !editor?.contains(active))
      ) {
        mobileComposerExpandInFlightRef.current = false;
        cancelComposerNormalResume();
        // A composer control keeps the body expanded so its focused node survives.
        if (
          !isInsideRestingComposerControlScope(active) &&
          !composerSurfaceRef.current?.contains(active) &&
          !composerFormRef.current?.contains(active)
        ) {
          setIsComposerFocused(false);
        }
        return;
      }
      if (cursor === undefined) composerEditorRef.current?.focusAtEnd();
      else composerEditorRef.current?.focusAt(cursor);
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
        // A real blur during expansion must still collapse after the focus frames.
        scheduleComposerCollapseCheck();
      });
    });
  });
  const expandMobileComposer = useStableCallback(() => expandMobileComposerAt());
  const focusComposerEditor = useStableCallback((cursor?: number) => {
    // A hidden editor cannot receive native focus. Keep NORMAL's requested offset.
    if (isComposerCollapsedMobile) expandMobileComposerAt(cursor);
    else if (cursor === undefined) composerEditorRef.current?.focusAtEnd();
    else composerEditorRef.current?.focusAt(cursor);
  });
  return { expandMobileComposer, focusComposerEditor, scheduleComposerCollapseCheck };
}
