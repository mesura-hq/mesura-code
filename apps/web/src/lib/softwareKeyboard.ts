type VirtualKeyboard = EventTarget & {
  readonly boundingRect: Pick<DOMRectReadOnly, "height">;
  readonly overlaysContent: boolean;
};

type KeyboardWindow = Pick<Window, "innerHeight" | "innerWidth" | "visualViewport"> & {
  readonly navigator: Navigator & { readonly virtualKeyboard?: VirtualKeyboard };
  readonly matchMedia?: Window["matchMedia"];
  readonly document?: Pick<Document, "activeElement">;
};

const KEYBOARD_THRESHOLD = 150;

function isEditable(element: Element | null | undefined) {
  if (!element) return false;
  if ((element as HTMLElement).isContentEditable) return true;
  return element.tagName === "TEXTAREA" || element.tagName === "INPUT";
}

/**
 * Mesura: Chrome on Android honors `interactive-widget=resizes-content` (index.html), so its
 * keyboard shrinks the layout viewport too and the visual-vs-layout check never fires. That
 * keyboard shows as a layout height below the one recorded at the same layout width while no
 * keyboard could show: a touch device with an editable element focused.
 */
function createLayoutKeyboardTracker(win: KeyboardWindow | undefined) {
  const closedHeightByWidth = new Map<number, number>();
  if (win) closedHeightByWidth.set(win.innerWidth, win.innerHeight);
  let open = false;
  // A keyboard still closing after blur reports heights that must not lower the closed one.
  let closingAfterBlur = false;
  // Rotating while the keyboard is open reaches a width with no closed height yet.
  let openAtUnknownWidth: { width: number; height: number } | null = null;

  const keyboardCanShow = () =>
    win?.matchMedia?.("(pointer: coarse)").matches === true &&
    isEditable(win.document?.activeElement);

  const evaluate = () => {
    if (!win) return false;
    const { innerWidth: width, innerHeight: height } = win;
    if (!keyboardCanShow()) {
      if (open) closingAfterBlur = true;
      const closedHeight = closedHeightByWidth.get(width);
      if (closedHeight === undefined || height >= closedHeight) closingAfterBlur = false;
      if (!closingAfterBlur) closedHeightByWidth.set(width, height);
      openAtUnknownWidth = null;
      open = false;
      return open;
    }
    closingAfterBlur = false;
    const closedHeight = closedHeightByWidth.get(width);
    if (closedHeight === undefined) {
      if (!open) {
        closedHeightByWidth.set(width, height);
      } else if (openAtUnknownWidth?.width !== width) {
        openAtUnknownWidth = { width, height };
      } else if (height - openAtUnknownWidth.height > KEYBOARD_THRESHOLD) {
        closedHeightByWidth.set(width, height);
        openAtUnknownWidth = null;
        open = false;
      } else {
        openAtUnknownWidth.height = Math.min(openAtUnknownWidth.height, height);
      }
      return open;
    }
    if (height > closedHeight) closedHeightByWidth.set(width, height);
    openAtUnknownWidth = null;
    // A focused split-screen resize with a hardware keyboard also reads as open: geometry alone
    // cannot tell it from this keyboard, and a stray newline costs less than an early send.
    open = Math.max(closedHeight, height) - height > KEYBOARD_THRESHOLD;
    return open;
  };

  return { evaluate };
}

function viewportSnapshot(viewport: VisualViewport) {
  return {
    width: Math.round(viewport.width),
    height: Math.round(viewport.height),
    scale: viewport.scale,
  };
}

export function createSoftwareKeyboardStore(win: KeyboardWindow | undefined, isDesktop: boolean) {
  const listeners = new Set<() => void>();
  let viewportOpen = false;
  const viewport = isDesktop ? undefined : win?.visualViewport;
  const keyboard = isDesktop ? undefined : win?.navigator.virtualKeyboard;
  let previous = viewport ? viewportSnapshot(viewport) : undefined;
  const layoutKeyboard = createLayoutKeyboardTracker(viewport ? win : undefined);

  const getSnapshot = () => {
    // Chromium can expose the API while withholding geometry outside overlay mode.
    // Keep the browser's automatic viewport resizing instead of enabling overlays.
    if (keyboard && (keyboard.overlaysContent || keyboard.boundingRect.height > 0)) {
      return keyboard.boundingRect.height > 0;
    }
    return viewportOpen;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const onViewportResize = () => {
    if (!viewport || !win) return;
    const current = viewportSnapshot(viewport);
    const layoutKeyboardOpen = layoutKeyboard.evaluate();
    // Adapted from Ionic's keyboard assist, MIT, Copyright (c) 2015-present Drifty Co.
    // https://github.com/ionic-team/ionic-framework/blob/main/core/src/utils/keyboard/keyboard.ts
    const scaledHeightDifference = previous
      ? (previous.height - current.height) * current.scale
      : 0;
    if (Math.abs(current.height - win.innerHeight / current.scale) <= 1) {
      viewportOpen = layoutKeyboardOpen;
    } else if (
      !viewportOpen &&
      previous?.width === current.width &&
      scaledHeightDifference > KEYBOARD_THRESHOLD
    ) {
      viewportOpen = true;
    }
    previous = current;
    notify();
  };

  const subscribe = (listener: () => void) => {
    if (isDesktop || !win) return () => {};
    if (listeners.size === 0) {
      if (viewport) {
        previous = viewportSnapshot(viewport);
        // A composer can mount after the keyboard has already opened.
        viewportOpen =
          win.innerHeight - previous.height * previous.scale > KEYBOARD_THRESHOLD ||
          layoutKeyboard.evaluate();
        viewport.addEventListener("resize", onViewportResize);
      }
      keyboard?.addEventListener("geometrychange", notify);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        viewport?.removeEventListener("resize", onViewportResize);
        keyboard?.removeEventListener("geometrychange", notify);
      }
    };
  };

  return { getSnapshot, subscribe };
}
