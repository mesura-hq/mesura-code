type VirtualKeyboard = EventTarget & {
  readonly boundingRect: Pick<DOMRectReadOnly, "height">;
  readonly overlaysContent: boolean;
};

type KeyboardWindow = Pick<Window, "innerHeight" | "visualViewport"> & {
  readonly navigator: Navigator & { readonly virtualKeyboard?: VirtualKeyboard };
};

const KEYBOARD_THRESHOLD = 150;

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
  // Mesura: Chrome on Android honors `interactive-widget=resizes-content` (index.html), so its
  // keyboard shrinks the layout viewport too and the visual-vs-layout check never fires. Compare
  // the layout height with the tallest one seen at the current width instead.
  let tallestLayout = previous
    ? { width: previous.width, height: win?.innerHeight ?? 0 }
    : undefined;
  const layoutShrunkByKeyboard = (current: { width: number }) => {
    if (!win) return false;
    if (!tallestLayout || tallestLayout.width !== current.width) {
      tallestLayout = { width: current.width, height: win.innerHeight };
    }
    tallestLayout.height = Math.max(tallestLayout.height, win.innerHeight);
    return tallestLayout.height - win.innerHeight > KEYBOARD_THRESHOLD;
  };

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
    // Adapted from Ionic's keyboard assist, MIT, Copyright (c) 2015-present Drifty Co.
    // https://github.com/ionic-team/ionic-framework/blob/main/core/src/utils/keyboard/keyboard.ts
    const scaledHeightDifference = previous
      ? (previous.height - current.height) * current.scale
      : 0;
    if (Math.abs(current.height - win.innerHeight / current.scale) <= 1) {
      viewportOpen = layoutShrunkByKeyboard(current);
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
          layoutShrunkByKeyboard(previous);
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
