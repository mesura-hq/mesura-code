import { expect, vi } from "vite-plus/test";

/**
 * ChatView refocuses the composer two frames after a window `focus` event when nothing holds the
 * keyboard, and a scroll-collapsed composer ignores focus in that event's frame. An unfocused test
 * window receives that event from the first focus inside it, which can land after a test has moved
 * the keyboard elsewhere (a blur, a chat motion, a question field). Focusing the window before the
 * app mounts means no such event comes later.
 */
export async function focusTestWindow() {
  window.focus();
  await vi.waitFor(() => expect(document.hasFocus(), "the test window has focus").toBe(true));
}
