import { type RefObject, useLayoutEffect, useRef } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cancelComposerNormalResume } from "../../keys/composer/composerSurface";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import { isInsideRestingComposerControlScope } from "./composerEventScope";
import { useFileManagerStore } from "../files/mesuraFileManager/fileManagerStore";

interface ExpandFocusRequest {
  readonly cursor: number | undefined;
  readonly previousFocus: Element | null;
  readonly draftKey: string;
}

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
  const pendingExpandFocusRef = useRef<ExpandFocusRequest | null>(null);
  const scheduleExpandFocus = useStableCallback(
    ({ cursor, previousFocus, draftKey }: ExpandFocusRequest) => {
      mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandFrameRef.current = null;
        const active = document.activeElement;
        const editor = composerSurfaceRef.current?.querySelector('[data-testid="composer-editor"]');
        // The expansion is committed by now. A new owner or draft cancels the
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
    },
  );
  // The hidden editor cannot take focus until React commits the expansion, which can land after
  // the next animation frame; the focus frame starts once it has.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus into the editor once the expansion is committed
  useLayoutEffect(() => {
    const request = pendingExpandFocusRef.current;
    if (isComposerCollapsedMobile || request === null) return;
    pendingExpandFocusRef.current = null;
    scheduleExpandFocus(request);
  }, [isComposerCollapsedMobile, scheduleExpandFocus]);
  const expandMobileComposerAt = useStableCallback((cursor?: number) => {
    const request = {
      cursor,
      previousFocus: document.activeElement,
      draftKey: composerDraftTargetKeyRef.current,
    };
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      mobileComposerExpandFrameRef.current = null;
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      mobileComposerExpandReleaseFrameRef.current = null;
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    if (isComposerCollapsedMobile) pendingExpandFocusRef.current = request;
    else scheduleExpandFocus(request);
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
