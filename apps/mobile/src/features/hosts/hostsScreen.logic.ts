/**
 * Mesura: what the mobile Hosts screen adds to the shared host stats view
 * logic (`@t3tools/client-runtime/host-stats/view`): the readings it keeps
 * across a released subscription, the environments a pull resubscribes, and
 * the words a screen reader hears for a row whose level is only a colour, and
 * the fill of a bar row.
 */
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type {
  HostStatsHistory,
  HostStatsRow,
  HostStatsSubscription,
} from "@t3tools/client-runtime/host-stats";
import type { HostStatsLevel } from "@t3tools/client-runtime/host-stats/levels";
import type { HostRowDisplay } from "@t3tools/client-runtime/host-stats/view";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * How long the refresh spinner stays up. Resubscribing is immediate and the
 * snapshot lands on its own, with its age on screen, so the spinner only
 * acknowledges the pull. It must be a separate commit from `true`: Android's
 * RefreshControl keeps spinning until it sees true, then false.
 */
export const HOST_STATS_REFRESH_SPINNER_MS = 600;

/**
 * Each environment's subscription, with the last history this screen held in
 * place of one a restarted subscription has not delivered yet. Mobile releases
 * its streams on blur and in the background (idle TTL 0), so a return starts
 * from an empty subscription; the held history keeps the last values on screen,
 * aged by the projection, until the new snapshot replaces them. It is marked
 * `held`, so the projection never shows it as live.
 */
export function holdLastReadings(
  held: ReadonlyMap<EnvironmentId, HostStatsHistory>,
  current: ReadonlyMap<EnvironmentId, HostStatsSubscription>,
): ReadonlyMap<EnvironmentId, HostStatsSubscription> {
  const merged = new Map<EnvironmentId, HostStatsSubscription>();
  for (const [environmentId, history] of held) {
    merged.set(environmentId, { history, failed: false, held: true });
  }
  for (const [environmentId, subscription] of current) {
    const kept = held.get(environmentId);
    merged.set(
      environmentId,
      subscription.history === null && kept !== undefined
        ? { ...subscription, history: kept, held: true }
        : subscription,
    );
  }
  return merged;
}

/**
 * The held histories after `subscriptions` delivered: every history a
 * subscription holds replaces the held one. Returns `held` itself when nothing
 * changed, so a caller can skip the write.
 */
export function nextHeldReadings(
  held: ReadonlyMap<EnvironmentId, HostStatsHistory>,
  subscriptions: ReadonlyMap<EnvironmentId, HostStatsSubscription>,
): ReadonlyMap<EnvironmentId, HostStatsHistory> {
  let next: Map<EnvironmentId, HostStatsHistory> | null = null;
  for (const [environmentId, subscription] of subscriptions) {
    const history = subscription.history;
    if (history === null || held.get(environmentId) === history) continue;
    next ??= new Map(held);
    next.set(environmentId, history);
  }
  return next ?? held;
}

/** The environments a pull to refresh resubscribes: the connected ones. */
export function hostsToResubscribe(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): ReadonlyArray<EnvironmentId> {
  const connected: EnvironmentId[] = [];
  for (const [environmentId, presentation] of presentations) {
    if (presentation.connection.phase === "connected") connected.push(environmentId);
  }
  return connected;
}

const LEVEL_WORD = { ok: null, warn: "warning", crit: "critical" } as const;

/**
 * What a screen reader hears for one row: its label, value and suffix, then
 * the worse of its two levels in words, since on screen the level is a colour.
 */
export function hostRowAccessibilityLabel(display: HostRowDisplay, row: HostStatsRow): string {
  const hasLevel = (level: HostStatsRow["level"]) =>
    row.level === level || row.secondaryLevel === level;
  const level = hasLevel("crit") ? "crit" : hasLevel("warn") ? "warn" : "ok";
  const word = LEVEL_WORD[level];
  const reading = [display.label, display.value, display.suffix].filter(Boolean).join(" ");
  return word === null ? reading : `${reading}, ${word}`;
}

/**
 * A bar row's fill: the Usage screen meter's solid amber and red for a warning
 * and a critical level (`WindowRow` in `UsageLimitsSection.tsx`). The theme's
 * `bg-warning` and `bg-danger` are pale surface tints, not fills: a swap bar at
 * 98 % drawn with them read as pale pink.
 */
export function hostBarFillClass(level: HostStatsLevel | null): string {
  if (level === "crit") return "bg-red-500";
  if (level === "warn") return "bg-amber-500";
  return "bg-foreground-muted";
}
