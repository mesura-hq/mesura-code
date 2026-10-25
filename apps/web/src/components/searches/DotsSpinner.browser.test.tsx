/**
 * Phase 3 of the search unification cycle, criterion 4: the Dots mark cycles
 * braille frames on an interval of about 110 ms, and only while it is
 * mounted (AGENTS.md: no continuously repainting animation). Where it is
 * mounted, inside the sidebar Search field and the popup input while a
 * search runs, is pinned by `AppRoot.agentSearchPopup.fence.browser.test.tsx`.
 */
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { DotsSpinner } from "./DotsSpinner";

const BRAILLE = /^[\u2800-\u28FF]+$/u;

it("dots spinner spec: the mark steps to another braille frame after about 110 ms", async () => {
  // The interval starts on mount, so the clock is fake before the first render.
  using _timers = fakeTimers();
  // The mark reads no route.
  await using screen = await render(<DotsSpinner />, { router: false });
  const firstFrame = screen.container.textContent ?? "";
  expect(firstFrame).toMatch(BRAILLE);

  await act(async () => {
    vi.advanceTimersByTime(110);
  });

  const nextFrame = screen.container.textContent ?? "";
  expect(nextFrame).toMatch(BRAILLE);
  expect(nextFrame).not.toBe(firstFrame);
});

it("dots spinner spec: unmounting the mark leaves no timer running", async () => {
  using _timers = fakeTimers();
  // The mark reads no route.
  await using screen = await render(<DotsSpinner />, { router: false });
  expect(vi.getTimerCount(), "the mark animates while mounted").toBeGreaterThan(0);

  await screen.unmount();

  expect(vi.getTimerCount()).toBe(0);
});
