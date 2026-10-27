import { InfoIcon } from "lucide-react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

it("commits a dismissal when the thread switches during the exit transition", async () => {
  const onDismiss = vi.fn();
  const item: ComposerBannerStackItem = {
    id: "notice",
    variant: "info",
    icon: <InfoIcon />,
    title: "Thread A notice",
    dismissLabel: "Dismiss notice",
    onDismiss,
  };
  await using screen = await render(<ComposerBannerStack key="thread-a" items={[item]} />);

  await userEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  // The composer keys the stack by thread, so switching threads remounts it mid-exit.
  await screen.rerender(<ComposerBannerStack key="thread-b" items={[]} />);

  await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
});

/**
 * Phase 6 guard (thread-attention plan): the pinned action dock extends this dismiss. Only a
 * browser shows that the exit transition runs before the notice is removed, and that a second
 * press during the exit does nothing.
 */
function notice(onDismiss: () => void) {
  return {
    id: "composer-banner-stack-guard-notice",
    variant: "info" as const,
    icon: <InfoIcon />,
    title: "A notice the developer can close",
    dismissLabel: "Dismiss the guard notice",
    onDismiss,
  };
}

it("phase6 dock guard the banner stack X dismisses its notice once, after the 220 ms exit", async () => {
  const onDismiss = vi.fn();
  await using screen = await render(<ComposerBannerStack items={[notice(onDismiss)]} />, {
    router: false,
  });
  using _timers = fakeTimers();
  const dismiss = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss the guard notice"]',
  );
  expect(dismiss).not.toBeNull();
  await act(async () => dismiss!.click());
  await act(async () => vi.advanceTimersByTime(219));
  expect(onDismiss).not.toHaveBeenCalled();
  await act(async () => dismiss!.click());
  await act(async () => vi.advanceTimersByTime(1));
  expect(onDismiss).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTime(220));
  expect(onDismiss).toHaveBeenCalledOnce();
});
