import { accountLimitsWindowKey } from "@t3tools/contracts";
// A single circular arrow, not one of the two-arrow refresh glyphs: this panel
// already says "Refresh failed" about the reading itself, and a window resetting
// is a different event from Mesura Code re-reading it.
import { RotateCcwIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";

import { cn } from "../../lib/utils";
import {
  useAccountLimits,
  type AccountLimitsRow,
  type AccountLimitsView,
} from "../../state/accountLimits";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SUBSCRIPTION_ICON_BY_NAMESPACE } from "../chat/providerIconUtils";
import { ScrollArea } from "../ui/scroll-area";
import { formatCompactDuration } from "@t3tools/client-runtime/host-stats/view";
import { useSidebarDockController, type SidebarDockController } from "./sidebarDockController";

/**
 * How far apart two rows start their entrance, and how many rows still get a
 * later start than the one above. Past the cap the stagger stops reading as
 * sequence and starts reading as the last row lagging.
 */
const ROW_ENTRANCE_STEP_MS = 45;
const ROW_ENTRANCE_MAX_STEPS = 5;

export function rowEntranceDelayMs(index: number, open: boolean): number {
  if (!open) return 0;
  return Math.min(index, ROW_ENTRANCE_MAX_STEPS) * ROW_ENTRANCE_STEP_MS;
}

export type AccountLimitsPanelController = SidebarDockController;

/** The usage dock's controller: the shared sidebar dock controller on Alt+U. */
export function useAccountLimitsPanelController(enabled: boolean): AccountLimitsPanelController {
  return useSidebarDockController({ dock: "usage", command: "usage.peek", enabled });
}

/**
 * How long this window has left. `shown` has no leading words (the rotate icon says it) while
 * `spoken` says it in full; they differ because a reset window shows "due".
 */
function resetRemaining(
  resetsAt: string | null,
  environmentNowMs: number | null,
): { readonly shown: string; readonly spoken: string } | null {
  if (resetsAt === null || environmentNowMs === null) return null;
  const resetAtMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetAtMs)) return null;
  const remaining = resetAtMs - environmentNowMs;
  if (remaining <= 0) return { shown: "due", spoken: "Reset due" };
  const shown = formatCompactDuration(remaining);
  return { shown, spoken: `Resets in ${shown}` };
}

function readingAgeLabel(readingAgeMs: number | null): string | null {
  if (readingAgeMs === null) return null;
  if (readingAgeMs < 60_000) return "Updated just now";
  return `Updated ${formatCompactDuration(readingAgeMs)} ago`;
}

function AccountLimitRowView(props: {
  readonly row: AccountLimitsRow;
  readonly index: number;
  readonly open: boolean;
}) {
  const { index, open, row } = props;
  const ageLabel = readingAgeLabel(row.readingAgeMs);
  const SubscriptionIcon = row.namespace
    ? SUBSCRIPTION_ICON_BY_NAMESPACE[row.namespace]
    : undefined;
  return (
    // Each row arrives a beat after the one above it; closing drops every delay to zero, since a
    // staggered exit makes dismissal feel slow. A subscription whose first reading lands while the
    // panel is open mounts with `open` true and appears at once: news, not part of an entrance.
    <section
      className={cn(
        "border-border/50 border-t px-3 py-2.5 transition-[opacity,transform] duration-200 ease-out [&:first-of-type]:border-t-0",
        "motion-reduce:transform-none motion-reduce:transition-none",
        open ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
      style={{ transitionDelay: `${rowEntranceDelayMs(index, open)}ms` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* One slot whichever branch fills it, or rows sit a unit apart. The vendor's mark wins;
            only a reading that names no vendor falls back to the agent's icon, the one row an
            accent colour belongs to (a subscription several agents read has no one colour). */}
        <span className="flex size-5 shrink-0 items-center justify-center">
          {SubscriptionIcon ? (
            <SubscriptionIcon aria-hidden className="size-4 text-foreground/80" />
          ) : row.driver ? (
            <ProviderInstanceIcon
              accentColor={row.accentColor}
              className="size-5"
              displayName={row.providerLabel}
              driverKind={row.driver}
              iconClassName="size-4 text-foreground/80"
              showBadge={Boolean(row.accentColor)}
            />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">
              {row.providerLabel}
            </span>
            {row.plan ? (
              <span className="truncate font-mono text-caption text-muted-foreground/65">
                {row.plan}
              </span>
            ) : null}
          </div>
          {row.subtitle ? (
            <div className="truncate text-caption text-muted-foreground/60">{row.subtitle}</div>
          ) : null}
        </div>
        {ageLabel ? (
          <span className="shrink-0 font-mono text-micro text-muted-foreground/55">
            {ageLabel.replace("Updated ", "")}
          </span>
        ) : null}
      </div>

      {row.windows.length > 0 ? (
        <div className="mt-2 space-y-2">
          {row.windows.map((rowWindow) => {
            const { window } = rowWindow;
            const usedPercent = Math.round(window.usedPercent);
            const remaining = resetRemaining(window.resetsAt, rowWindow.environmentNowMs);
            return (
              <div key={accountLimitsWindowKey(window)}>
                <div className="mb-1 flex items-center justify-between gap-3 font-mono text-caption">
                  <span className="text-muted-foreground">{window.label}</span>
                  <span className="flex items-center gap-1">
                    {remaining ? (
                      <>
                        <RotateCcwIcon
                          aria-hidden
                          className="size-2.5 shrink-0 text-muted-foreground/50"
                        />
                        <span className="text-muted-foreground/60">
                          <span className="sr-only">{remaining.spoken}</span>
                          <span aria-hidden>{remaining.shown}</span>
                        </span>
                        <span aria-hidden className="text-muted-foreground/35">
                          ·
                        </span>
                      </>
                    ) : null}
                    <span className="tabular-nums text-foreground/75">{usedPercent}%</span>
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-foreground/8">
                  <div
                    className="h-full rounded-full bg-foreground/45"
                    style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-2 text-search-label text-muted-foreground">
          {row.state === "missing" ? "No reading yet" : "No visible limits reported"}
        </div>
      )}

      {row.state === "stale" || row.state === "stale-refresh-failed" ? (
        <div className="mt-2 text-caption text-muted-foreground/65">Reading may be stale</div>
      ) : null}
      {row.state === "refresh-failed" || row.state === "stale-refresh-failed" ? (
        <div className="mt-1 text-caption text-muted-foreground/65">
          Refresh failed{row.windows.length > 0 ? " · showing the last reading" : ""}
        </div>
      ) : null}
      {/* Replaces the refresh-failed line rather than stacking with it: the two
          say contradictory things about whose fault the failure is. */}
      {row.state === "not-understood" ? (
        <div className="mt-1 text-caption text-muted-foreground/65">
          Reading not understood. Update Mesura Code
          {row.windows.length > 0 ? " · showing the last reading" : ""}
        </div>
      ) : null}
    </section>
  );
}

export function AccountLimitsPanelContent(props: {
  readonly view: AccountLimitsView;
  readonly shortcutLabel: string | null;
  readonly open: boolean;
}) {
  const { open, view, shortcutLabel } = props;
  const headingId = useId();
  const disconnected = view.environments.filter(
    (environment) => environment.state !== "ready" && environment.state !== "pending",
  );
  const emptyMessage = view.environments.some(
    (environment) => environment.state === "unsupported-contract",
  )
    ? "Update the environment to view limits"
    : view.environments.some((environment) => environment.state === "disconnected")
      ? "Environment disconnected"
      : view.environments.some((environment) => environment.state === "error")
        ? "Could not load account limits"
        : "No account limits available";
  return (
    // Two horizontal rules and a recessed fill delimit the flush dock; a box outline would double
    // the sidebar's border. The fill derives from theme tokens so a custom theme reaches it, and
    // `--sidebar-control-surface` is the raised pill surface, wrong here. `data-usage-limits-panel`
    // styles nothing now; it stays as a stable selector for browser checks.
    <div
      aria-labelledby={headingId}
      className="border-border/60 border-y bg-foreground/[0.035] dark:bg-sidebar-recess"
      data-usage-limits-panel
      role="group"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span
          className="text-caption font-medium uppercase tracking-wide text-muted-foreground/70"
          id={headingId}
        >
          Usage limits
        </span>
        {shortcutLabel ? (
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-px font-mono text-micro text-muted-foreground/80">
            {shortcutLabel}
          </kbd>
        ) : null}
      </header>

      {/* Two caps, the smaller wins: 55dvh clears four subscriptions of three windows each, and
          `100dvh-20rem` keeps the header, footer rows and a few threads on a short window. `dvh`
          because mobile browser chrome makes `vh` overstate the space. `scrollFade` masks only
          the edge that overflows. */}
      <div className="border-border/40 border-t">
        <ScrollArea className="max-h-[min(55dvh,calc(100dvh-20rem))]" scrollFade>
          {view.isPending ? (
            <div className="px-3 py-4 text-center text-search-label text-muted-foreground">
              Checking limits…
            </div>
          ) : view.rows.length === 0 ? (
            <div className="px-3 py-4 text-center text-search-label text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            view.rows.map((row, index) => (
              <AccountLimitRowView index={index} key={row.key} open={open} row={row} />
            ))
          )}

          {view.isPartial || disconnected.length > 0 ? (
            <footer className="border-border/50 border-t px-3 py-1.5 text-micro text-muted-foreground/55">
              Some environments are unavailable
            </footer>
          ) : null}
        </ScrollArea>
      </div>
    </div>
  );
}

/**
 * The panel as a band of the sidebar directly above the row that opens it. It replaced a popover
 * that floated over the chat canvas and printed the surface boundary through its glass. It takes
 * and traps no focus, so the composer or the terminal keeps the caret while it is open.
 */
export function AccountLimitsDock(props: { readonly controller: AccountLimitsPanelController }) {
  const { controller } = props;
  const view = useAccountLimits();
  const { refresh } = view;
  const wasOpen = useRef(false);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: refreshes the external usage reading on the controller's closed-to-open transition
  useEffect(() => {
    if (controller.open && !wasOpen.current) refresh();
    wasOpen.current = controller.open;
  }, [controller.open, refresh]);

  return (
    // `grid-template-rows` going `0fr` to `1fr` sizes the panel without measuring it; engines that
    // cannot interpolate it snap open. The negative inline margin cancels the footer's padding.
    // `inert` keeps the clipped closed panel out of focus and find-in-page (Base UI gives the
    // scroll viewport `tabIndex=0` on overflow); `aria-hidden` is `true` or absent, never "false".
    <div
      aria-hidden={controller.open ? undefined : true}
      className={cn(
        "-mx-[var(--sidebar-content-inset)] grid transition-[grid-template-rows] duration-200 ease-out",
        "motion-reduce:transition-none",
        controller.open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
      inert={!controller.open}
      {...controller.surfaceProps}
    >
      <div className="min-h-0 overflow-hidden">
        <AccountLimitsPanelContent
          open={controller.open}
          shortcutLabel={controller.shortcutLabel}
          view={view}
        />
      </div>
    </div>
  );
}
