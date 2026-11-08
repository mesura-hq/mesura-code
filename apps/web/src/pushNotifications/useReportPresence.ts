import { useEffect, useState } from "react";

import { onPageInput } from "./pageInput";

/** Input this recent, on a visible and focused page, shows the developer here. */
const ACTIVITY_WINDOW_MS = 2 * 60 * 1000;

/** No two reports closer than this, renewals included. */
const REPORT_INTERVAL_MS = 30 * 1000;

const PAGE_STATE_EVENTS = ["focus", "blur"] as const;

/**
 * Reports every transition, and renews an unchanged `active` report when input came after
 * the last one. The host forgets an active report two minutes after it was made
 * (`ClientPresence`), so transitions alone would lapse under a developer who keeps working.
 */
function followPresence(report: (active: boolean) => void): () => void {
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let sent: { readonly active: boolean; readonly at: number } | null = null;
  let wakeTimer: number | undefined;

  const isActive = (now: number) =>
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    now - lastInputAt < ACTIVITY_WINDOW_MS;

  /**
   * One timeout aimed at the next event-less state change. Do not replace it with a
   * periodic tick: a tick reports inactive up to one period late, so a developer gone
   * for two minutes would still hold the phone's pushes.
   */
  const scheduleNextCheck = (now: number, active: boolean, heldBack: boolean) => {
    window.clearTimeout(wakeTimer);
    wakeTimer = undefined;
    const wakeAt = Math.min(
      active ? lastInputAt + ACTIVITY_WINDOW_MS : Number.POSITIVE_INFINITY,
      heldBack && sent !== null ? sent.at + REPORT_INTERVAL_MS : Number.POSITIVE_INFINITY,
    );
    if (wakeAt === Number.POSITIVE_INFINITY) return;
    wakeTimer = window.setTimeout(update, Math.max(0, wakeAt - now));
  };

  function update() {
    const now = Date.now();
    const active = isActive(now);
    // Input during the interval is kept as a pending renewal, not dropped:
    // dropping it let the host forget the client up to 30 seconds before the
    // client went inactive, and a push in that gap reached the phone.
    const due =
      sent === null ? active : active !== sent.active || (active && lastInputAt > sent.at);
    const heldBack = due && sent !== null && now - sent.at < REPORT_INTERVAL_MS;
    if (due && !heldBack) {
      report(active);
      sent = { active, at: now };
    }
    scheduleNextCheck(now, active, heldBack);
  }

  const stopInput = onPageInput(() => {
    lastInputAt = Date.now();
    update();
  });
  document.addEventListener("visibilitychange", update);
  for (const type of PAGE_STATE_EVENTS) window.addEventListener(type, update);

  return () => {
    window.clearTimeout(wakeTimer);
    stopInput();
    document.removeEventListener("visibilitychange", update);
    for (const type of PAGE_STATE_EVENTS) window.removeEventListener(type, update);
  };
}

/** Opens one report on one environment and returns the function that ends it. */
type OpenReport = (active: boolean) => () => void;

/**
 * The page's presence, held on every environment attached to it: each gets
 * every report, and one that attaches while the developer is active is told
 * so at once.
 */
export interface PresenceHub {
  readonly report: (active: boolean) => void;
  /** Attaches a destination; the returned function ends its report and detaches it. */
  readonly attach: (open: OpenReport) => () => void;
}

function createPresenceHub(): PresenceHub {
  let current: boolean | null = null;
  const destinations = new Set<{ readonly open: OpenReport; close: (() => void) | null }>();
  return {
    report: (active) => {
      current = active;
      for (const destination of destinations) {
        destination.close?.();
        destination.close = destination.open(active);
      }
    },
    attach: (open) => {
      // The host reads no report as inactive, so only `active` is worth sending now.
      const destination = { open, close: current === true ? open(true) : null };
      destinations.add(destination);
      return () => {
        destination.close?.();
        destinations.delete(destination);
      };
    },
  };
}

/** Follows the page for as long as the caller is mounted; the hub carries its reports. */
export function useReportPresence(): PresenceHub {
  const [hub] = useState(createPresenceHub);
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to page input, focus and visibility events while mounted
  useEffect(() => followPresence(hub.report), [hub]);
  return hub;
}
