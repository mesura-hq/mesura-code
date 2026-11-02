import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import { ComposerBanner } from "./ComposerBanner";
import {
  ComposerBannerStack,
  NoticeText,
  type ComposerBannerStackItem,
} from "./ComposerBannerStack";

function notice(title: string, group?: ComposerBannerStackItem["group"]): ComposerBannerStackItem {
  return { id: title, variant: "default", icon: <InfoIcon />, title, ...(group ? { group } : {}) };
}

it("puts machine notices first, whatever order the notices arrive in", async () => {
  await using screen = await render(
    <ComposerBannerStack items={[notice("Branch changed"), notice("Offline", "environment")]} />,
  );

  expect(screen.container.textContent).toBe("OfflineBranch changed");
});

it("leaves the next attachment its own top edge when there are no notices", async () => {
  await using screen = await render(
    <ComposerBanner.Column>
      <ComposerBannerStack items={[]} />
      <ComposerBanner.Attachment>
        <ComposerBanner.Root data-testid="drawer">Approval</ComposerBanner.Root>
      </ComposerBanner.Attachment>
    </ComposerBanner.Column>,
  );

  const surface = getComputedStyle(screen.getByTestId("drawer").element(), "::before");
  expect(surface.borderTopWidth).toBe("1px");
  expect(surface.borderTopLeftRadius).not.toBe("0px");
});

function noticeRow(width: string, children: ReactNode) {
  return (
    <div data-testid="row" className="flex items-center gap-1.5" style={{ width }}>
      <NoticeText detailsLabel="Show details" className="min-w-0 truncate">
        {children}
      </NoticeText>
    </div>
  );
}

it("leaves out the details button when only a link's hit area reaches past the text", async () => {
  // Phones lay out in device pixels, so a range can measure one float32 step (2^-17 px at
  // this size) wider than its element. Headless Chromium's rects agree exactly.
  const rangeRect = Range.prototype.getBoundingClientRect;
  using _rangeRect = vi
    .spyOn(Range.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Range) {
      const rect = rangeRect.call(this);
      return new DOMRect(rect.x, rect.y, rect.width + 2 ** -17, rect.height);
    });
  // The flicker is a details button that mounts and then unmounts, so record every insertion.
  const inserted: Node[] = [];
  using observing = new DisposableStack();
  const mutations = new MutationObserver((records) =>
    inserted.push(...records.flatMap((record) => [...record.addedNodes])),
  );
  mutations.observe(document.body, { childList: true, subtree: true });
  observing.defer(() => mutations.disconnect());
  await using screen = await render(
    noticeRow(
      "20rem",
      <>
        Needs input{" "}
        <button type="button" className="relative after:absolute after:-inset-x-10 after:inset-y-0">
          Review
        </button>
      </>,
    ),
  );

  await expect.element(screen.getByText("Review")).toBeVisible();
  const details = [
    ...inserted,
    ...mutations.takeRecords().flatMap((record) => [...record.addedNodes]),
  ].filter(
    (node) =>
      node instanceof Element &&
      (node.matches('[aria-label="Show details"]') ||
        node.querySelector('[aria-label="Show details"]')),
  );
  expect(details).toEqual([]);
});

it("shows the details button while text or nested text is cut, until it fits again", async () => {
  await using screen = await render(noticeRow("4rem", "Waiting on a subagent with a long name"));
  const details = screen.getByRole("button", { name: "Show details" });
  await expect.element(details).toBeInTheDocument();

  await screen.rerender(noticeRow("4rem", "Ready"));
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(noticeRow("4rem", "Waiting on a subagent with a long name"));
  await expect.element(details).toBeInTheDocument();

  screen.getByTestId("row").element().style.width = "40rem";
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(
    noticeRow(
      "40rem",
      <span className="inline-block max-w-16 truncate align-bottom">A long nested name</span>,
    ),
  );
  await expect.element(details).toBeInTheDocument();

  await screen.rerender(
    <ComposerBanner.Root>
      {noticeRow("4rem", "Waiting on a subagent with a long name")}
    </ComposerBanner.Root>,
  );
  await expect.element(details).toBeInTheDocument();
  await screen.rerender(<ComposerBanner.Root>{noticeRow("4rem", "Ready")}</ComposerBanner.Root>);
  await expect.element(details).not.toBeInTheDocument();
});

it("opens the details of a long notice right above its button", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const script = Array.from({ length: 400 }, (_, line) => `echo "line ${line}"`).join("\n");
  const container = document.createElement("div");
  container.style.cssText = "position: fixed; bottom: 4rem; right: 4rem;";
  await using screen = await render(noticeRow("40rem", script), { container });
  const details = screen.getByRole("button", { name: "Show details" });
  await userEvent.hover(details);
  const popup = page.getByLabelText("Notice details");
  await expect.element(popup).toBeVisible();

  // A positioner sized to the unscrolled text flips beside the button and covers it.
  await vi.waitFor(() => {
    const gap =
      details.element().getBoundingClientRect().top -
      popup.element().getBoundingClientRect().bottom;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(8);
  });
});

/**
 * Phase 6 guard (thread-attention plan): the pinned action dock extends this dismiss. Only a
 * browser shows that the exit transition runs before the notice is removed, and that a second
 * press during the exit does nothing.
 */
function dismissibleNotice(onDismiss: () => void) {
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
  await using screen = await render(
    <ComposerBannerStack items={[dismissibleNotice(onDismiss)]} />,
    {
      router: false,
    },
  );
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
