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
import { formatCompactDuration } from "./AccountLimitsPanel.logic";
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
 * How long this window has left.
 *
 * `shown` carries no leading words because the rotate icon beside it says what
 * it is; `spoken` says it in full for anyone who cannot see that icon. They are
 * separate because a window that has already reset shows "due", and "Resets in
 * due" is not a sentence.
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
    // Each row arrives a beat after the one above it, so the panel reads as a
    // list filling in rather than a block appearing. Closing drops every delay
    // to zero: a staggered exit makes dismissal feel slower than it is, and the
    // dock collapses over the top of it anyway.
    //
    // The sequence covers the rows present when the panel opens. A subscription
    // whose first reading lands while the panel is already open mounts with
    // `open` true and appears at once, which is right — it is news arriving,
    // not part of an entrance.
    <section
      className={cn(
        "border-border/50 border-t px-3 py-2.5 transition-[opacity,transform] duration-200 ease-out [&:first-of-type]:border-t-0",
        "motion-reduce:transform-none motion-reduce:transition-none",
        open ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
      style={{ transitionDelay: `${rowEntranceDelayMs(index, open)}ms` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* One slot whichever branch fills it, or rows sit a unit apart.
            The vendor's mark comes first, because a directly polled plan has a
            vendor as much as an agent-read one does. Only a reading that names
            no vendor falls back to the agent's icon — and that is also the only
            row an accent colour belongs to, since an accent is set on an agent
            and a subscription several agents read has no one agent's colour. */}
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
              <span className="truncate font-mono text-[10px] text-muted-foreground/65">
                {row.plan}
              </span>
            ) : null}
          </div>
          {row.subtitle ? (
            <div className="truncate text-[10px] text-muted-foreground/60">{row.subtitle}</div>
          ) : null}
        </div>
        {ageLabel ? (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/55">
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
                <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[10px]">
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
        <div className="mt-2 text-[11px] text-muted-foreground">
          {row.state === "missing" ? "No reading yet" : "No visible limits reported"}
        </div>
      )}

      {row.state === "stale" || row.state === "stale-refresh-failed" ? (
        <div className="mt-2 text-[10px] text-muted-foreground/65">Reading may be stale</div>
      ) : null}
      {row.state === "refresh-failed" || row.state === "stale-refresh-failed" ? (
        <div className="mt-1 text-[10px] text-muted-foreground/65">
          Refresh failed{row.windows.length > 0 ? " · showing the last reading" : ""}
        </div>
      ) : null}
      {/* Replaces the refresh-failed line rather than stacking with it: the two
          say contradictory things about whose fault the failure is. */}
      {row.state === "not-understood" ? (
        <div className="mt-1 text-[10px] text-muted-foreground/65">
          Reading not understood — update Mesura Code
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
    // Two horizontal rules and a fill one step off the sidebar's own are the
    // whole delimitation: the dock is flush with the sidebar's edges, so a box
    // outline would draw two vertical lines onto the sidebar's own border.
    //
    // The fill is recessed — the band sits below the sidebar's own surface, not
    // on top of it — and both halves of it are relative to theme tokens rather
    // than to a literal colour, because this app ships a theme editor and a
    // hardcoded fill would be the one surface in the sidebar a custom theme
    // could not reach. Light mode tints toward `--foreground`; dark mode
    // composites `--background` over the sidebar, which is darker than
    // `--sidebar` in every theme since the sidebar is built from `--card`.
    // `--sidebar-control-surface` was the obvious token and is wrong here: it
    // is the *raised* surface the provider-update pill uses, so it would lift
    // the band off the sidebar instead of sinking it.
    //
    // `data-usage-limits-panel` no longer drives any stylesheet — the rule it
    // fed went with the popover. It is kept as a stable selector for browser
    // checks, which is why nothing asserts its presence.
    <div
      aria-labelledby={headingId}
      className="border-border/60 border-y bg-foreground/[0.035] dark:bg-[color-mix(in_srgb,var(--background)_45%,transparent)]"
      data-usage-limits-panel
      role="group"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span
          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70"
          id={headingId}
        >
          Usage limits
        </span>
        {shortcutLabel ? (
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-px font-mono text-[9px] text-muted-foreground/80">
            {shortcutLabel}
          </kbd>
        ) : null}
      </header>

      {/* Two caps, and the smaller wins. 55dvh has to clear four subscriptions
          of three windows each — 442px, what this machine reads today — or the
          panel scrolls on the ordinary case and its last row is always cut.
          `100dvh-20rem` is the other end: on a short window 55% of it is still
          most of the sidebar, so the subtrahend reserves the header, the footer
          rows and a few threads. Without it the thread list is squeezed to
          nothing on a 600px window, which is the outcome a viewport-relative
          cap alone quietly permits.
          `dvh` rather than `vh` because the web surface runs in mobile browsers
          whose chrome makes `vh` overstate the space by its height.
          `scrollFade` is the sidebar list's own affordance and masks only the
          edge that actually overflows, so a panel that fits gets no mask. */}
      <ScrollArea
        className="max-h-[min(55dvh,calc(100dvh-20rem))] border-border/40 border-t"
        scrollFade
      >
        {view.isPending ? (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            Checking limits…
          </div>
        ) : view.rows.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          view.rows.map((row, index) => (
            <AccountLimitRowView index={index} key={row.key} open={open} row={row} />
          ))
        )}

        {view.isPartial || disconnected.length > 0 ? (
          <footer className="border-border/50 border-t px-3 py-1.5 text-[9px] text-muted-foreground/55">
            Some environments are unavailable
          </footer>
        ) : null}
      </ScrollArea>
    </div>
  );
}

/**
 * The panel as a band of the sidebar, sitting directly above the row that
 * opens it.
 *
 * This replaced a popover. A popover floated over the chat canvas whenever the
 * sidebar was narrower than it, which put two surfaces of different shades
 * under one sheet of glass and printed their boundary through it. A band that
 * belongs to the sidebar cannot cross onto anything, so the whole problem —
 * and the stylesheet that fought it — goes away.
 *
 * It also takes no focus and traps none, so the composer or the terminal keeps
 * the caret while the panel is open. The popover needed two explicit props to
 * get that; a plain div needs none.
 */
export function AccountLimitsDock(props: { readonly controller: AccountLimitsPanelController }) {
  const { controller } = props;
  const view = useAccountLimits();
  const wasOpen = useRef(false);
  useEffect(() => {
    if (controller.open && !wasOpen.current) view.refresh();
    wasOpen.current = controller.open;
  }, [controller.open, view.refresh]);

  return (
    // Height comes from `grid-template-rows` going `0fr` to `1fr`, so the panel
    // opens to whatever it measures without anything measuring it. Browsers
    // that cannot interpolate that property snap open instead of sliding, which
    // is the correct degradation and is not the desktop app's engine.
    //
    // The negative inline margin cancels the footer's padding: a delimiter that
    // stops short of the sidebar's edges reads as a card, not as a division of
    // the sidebar itself.
    // `inert` is what actually takes the closed panel out of the page, and
    // `aria-hidden` alone would not have. A collapsed row is clipped, not
    // removed: Base UI gives the scroll viewport `tabIndex=0` the moment its
    // content overflows, so without `inert` a keyboard user tabs into an
    // invisible region and find-in-page matches text nobody can see. `inert`
    // drops focus, pointer targeting and find-in-page for the whole subtree.
    //
    // `aria-hidden` is set to `true` or left off, never to `"false"` — an
    // explicit false does nothing on its own and misleads under an ancestor
    // that is itself hidden.
    <div
      aria-hidden={controller.open ? undefined : true}
      className={cn(
        "-mx-[var(--sidebar-content-inset)] grid transition-[grid-template-rows] duration-200 ease-out",
        "motion-reduce:transition-none",
        controller.open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
      inert={!controller.open}
      onPointerEnter={controller.onPointerEnter}
      onPointerLeave={controller.onPointerLeave}
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
