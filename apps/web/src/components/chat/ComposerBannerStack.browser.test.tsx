/**
 * Phase 6 guard (thread-attention plan): the banner stack's dismiss, which the pinned action
 * dock extends. Entry point: `ComposerBannerStack` as `ChatComposer` mounts it, with a notice
 * item carrying `onDismiss`. What only a browser shows: the exit transition runs before the
 * notice is removed, and a second press during the exit does nothing.
 */
import { InfoIcon } from "lucide-react";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";

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
