import { expect, vi } from "vite-plus/test";

/**
 * ChatView refocuses the composer two frames after a window `focus` event. An unfocused test window
 * gets that event on the first focus inside it, possibly after a test moved the keyboard elsewhere.
 * Focusing the window before the app mounts means no such event comes later.
 */
export async function focusTestWindow() {
  window.focus();
  await vi.waitFor(() => expect(document.hasFocus(), "the test window has focus").toBe(true));
}
