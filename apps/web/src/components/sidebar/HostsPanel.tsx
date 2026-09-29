import {
  projectHostStats,
  type HostStatsHostView,
  type HostStatsRow,
} from "@t3tools/client-runtime/host-stats";
import type { HostStatsLevel } from "@t3tools/client-runtime/host-stats/levels";
import { ServerIcon } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import { cn } from "../../lib/utils";
import { useHostStatsSources } from "../../state/hostStats";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { rowEntranceDelayMs } from "./AccountLimitsPanel";
import { HostSparkline } from "./HostSparkline";
import {
  HOST_STATS_AGE_REFRESH_MS,
  HOSTS_DOCK_ROW_IDS,
  HOSTS_DOCK_ROW_VISUAL,
  createHostStatsAgeClock,
  formatUptime,
  hostFleetSummary,
  hostIsDimmed,
  hostRowDisplay,
  hostServersLine,
  hostStatusLine,
  sparklineMax,
  sparklineReading,
  type HostStatsAgeClock,
  type HostsDockRowId,
} from "./HostsPanel.logic";
import type { SidebarDockController } from "./sidebarDockController";

const SPARKLINE_HEIGHT = 20;
const STEP_SPARKLINE_HEIGHT = 16;

function levelTextClass(level: HostStatsLevel | null): string | undefined {
  if (level === "crit") return "text-destructive-foreground";
  if (level === "warn") return "text-warning-foreground";
  return undefined;
}

function levelBarClass(level: HostStatsLevel | null): string {
  if (level === "crit") return "bg-destructive";
  if (level === "warn") return "bg-warning";
  return "bg-foreground/45";
}

/**
 * The time the open dock projects with. It moves at most every 15 s and only
 * while the dock is open, so the ages on screen advance without a closed dock
 * re-rendering, and without a repaint every second.
 */
function useHostStatsNow(open: boolean): number {
  const [nowLocal, setNowLocal] = useState(() => Date.now());
  const clockRef = useRef<HostStatsAgeClock | null>(null);
  if (clockRef.current === null) {
    clockRef.current = createHostStatsAgeClock({
      intervalMs: HOST_STATS_AGE_REFRESH_MS,
      now: () => Date.now(),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onTick: setNowLocal,
    });
  }
  useEffect(() => {
    clockRef.current?.setOpen(open);
  }, [open]);
  useEffect(() => () => clockRef.current?.dispose(), []);
  return nowLocal;
}

/** The detail a value's short form leaves out, on hover. */
function HostHint(props: { readonly hint: string | null; readonly children: ReactElement }) {
  if (props.hint === null) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top">{props.hint}</TooltipPopup>
    </Tooltip>
  );
}

const HostRow = memo(function HostRow(props: {
  readonly host: HostStatsHostView;
  readonly rowId: HostsDockRowId;
  readonly row: HostStatsRow;
}) {
  const { host, row, rowId } = props;
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const display = hostRowDisplay(rowId, row);
  const visual = HOSTS_DOCK_ROW_VISUAL[rowId];
  const reading = hoverSlot === null ? null : sparklineReading(host, rowId, hoverSlot);
  return (
    // Prototype B: label, history, value, on a `38px 1fr 76px` grid. One grid
    // per row rather than one per host, so a row can anchor its own readout.
    <div
      className="relative grid grid-cols-[38px_1fr_76px] items-center gap-x-2"
      data-host-row={rowId}
    >
      <span className="font-mono text-[10px] text-muted-foreground">{display.label}</span>
      <div className="min-w-0">
        {visual === "bar" ? (
          <div className="h-1 overflow-hidden rounded-full bg-foreground/8" data-host-bar>
            <div
              className={cn("h-full rounded-full", levelBarClass(row.level))}
              style={{ width: `${Math.min(100, Math.max(0, row.value ?? 0))}%` }}
            />
          </div>
        ) : row.series === null ? null : (
          <HostSparkline
            height={visual === "step" ? STEP_SPARKLINE_HEIGHT : SPARKLINE_HEIGHT}
            hoverSlot={hoverSlot}
            label={`${display.label}, last 12 hours`}
            level={row.level}
            max={sparklineMax(rowId, row.series)}
            onHoverSlot={setHoverSlot}
            peakSeries={row.peakSeries}
            series={row.series}
            step={visual === "step"}
          />
        )}
      </div>
      <HostHint hint={display.title}>
        <span
          className={cn(
            "truncate text-right text-[12.5px] font-semibold tabular-nums text-foreground",
            levelTextClass(row.level),
          )}
        >
          {display.value}
          {display.suffix ? (
            <small
              className={cn(
                "ml-0.5 font-mono text-[9.5px] font-normal text-muted-foreground",
                levelTextClass(row.secondaryLevel),
              )}
            >
              {display.suffix}
            </small>
          ) : null}
        </span>
      </HostHint>
      {/* The hovered bucket floats above its row like a tooltip: the dock is
          too narrow to give it a column, and it only exists under the pointer. */}
      {reading === null ? null : (
        <span
          className="pointer-events-none absolute right-0 bottom-full z-10 mb-0.5 whitespace-nowrap rounded border border-border/60 bg-popover px-1.5 py-px font-mono text-[10px] text-popover-foreground shadow-sm"
          data-sparkline-readout
        >
          {reading.time} · {reading.value}
        </span>
      )}
    </div>
  );
});

function HostSection(props: {
  readonly host: HostStatsHostView;
  readonly index: number;
  readonly open: boolean;
}) {
  const { host, index, open } = props;
  const status = hostStatusLine(host);
  const showsUptime = host.uptimeMs !== null && (host.state === "live" || host.state === "stale");
  const servers = host.rows === null ? null : hostServersLine(host.rows.servers);
  return (
    // Hosts arrive a beat apart and leave together, as the usage dock's rows do.
    <section
      className={cn(
        "border-border/50 border-t px-3 py-2.5 transition-[opacity,transform] duration-200 ease-out [&:first-of-type]:border-t-0",
        "motion-reduce:transform-none motion-reduce:transition-none",
        open ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
      data-host={host.environmentId}
      data-host-state={host.state}
      style={{ transitionDelay: `${rowEntranceDelayMs(index, open)}ms` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ServerIcon aria-hidden className="size-3.5 shrink-0 text-foreground/70" />
        <span className="truncate text-xs font-medium text-foreground">{host.label}</span>
        {host.isPrimary ? (
          <span className="shrink-0 rounded border border-border px-1 font-mono text-[9px] text-muted-foreground">
            local
          </span>
        ) : host.platform ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground/65">
            {host.platform}
          </span>
        ) : null}
        {showsUptime ? (
          <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/55">
            {formatUptime(host.uptimeMs!)}
          </span>
        ) : null}
      </div>
      {status ? (
        <div className="mt-1 text-[10px] text-muted-foreground/75">{status.text}</div>
      ) : null}
      {host.rows === null ? null : (
        // Stale and offline keep their numbers, dimmed, under a line that
        // says how old they are: hiding them would lose the last thing known.
        <div className={cn(hostIsDimmed(host) && "opacity-55")}>
          <div className="mt-2 flex flex-col gap-1.5">
            {HOSTS_DOCK_ROW_IDS.map((rowId) => (
              <HostRow host={host} key={rowId} row={host.rows![rowId]} rowId={rowId} />
            ))}
          </div>
          {servers ? (
            <HostHint hint={servers.title}>
              <div
                className="mt-1.5 flex w-fit items-center gap-1 text-[10.5px] text-muted-foreground"
                data-host-servers
              >
                <ServerIcon aria-hidden className="size-3 shrink-0" />
                {servers.text}
              </div>
            </HostHint>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function HostsPanelContent(props: {
  readonly hosts: ReadonlyArray<HostStatsHostView>;
  readonly shortcutLabel: string | null;
  readonly open: boolean;
}) {
  const { hosts, open, shortcutLabel } = props;
  const headingId = useId();
  return (
    // The usage dock's surface, for the same reasons (see
    // `AccountLimitsPanelContent`): two horizontal rules and a recessed fill
    // built from theme tokens are the whole delimitation, because the dock is
    // flush with the sidebar's edges and a custom theme has to reach it.
    //
    // `data-hosts-panel` is a stable selector for tests and browser checks.
    <div
      aria-labelledby={headingId}
      className="border-border/60 border-y bg-foreground/[0.035] dark:bg-[color-mix(in_srgb,var(--background)_45%,transparent)]"
      data-hosts-panel
      role="group"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span
          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70"
          id={headingId}
        >
          Hosts
        </span>
        {shortcutLabel ? (
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-px font-mono text-[9px] text-muted-foreground/80">
            {shortcutLabel}
          </kbd>
        ) : null}
      </header>

      {/* The usage dock's cap: the smaller of 55dvh and the window less the
          sidebar's header, footer and a few threads. */}
      <ScrollArea
        className="max-h-[min(55dvh,calc(100dvh-20rem))] border-border/40 border-t"
        scrollFade
      >
        {hosts.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            No hosts connected
          </div>
        ) : (
          <>
            <div className="border-border/50 border-b px-3 py-1.5 font-mono text-[10px] text-muted-foreground/70">
              {hostFleetSummary(hosts)}
            </div>
            {hosts.map((host, index) => (
              <HostSection host={host} index={index} key={host.environmentId} open={open} />
            ))}
          </>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * The Hosts dock: a band of the sidebar above the footer row that opens it,
 * built exactly like `AccountLimitsDock` — see its comments for why a band and
 * not a popover, why `inert`, and why the negative inline margin.
 *
 * It subscribes to host stats only while open, and re-projects on its own
 * 15-second clock so the ages move while it is on screen.
 */
export function HostsDock(props: { readonly controller: SidebarDockController }) {
  const { controller } = props;
  const sources = useHostStatsSources(controller.open);
  const nowLocal = useHostStatsNow(controller.open);
  const hosts = useMemo(() => projectHostStats({ ...sources, nowLocal }), [sources, nowLocal]);
  return (
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
        <HostsPanelContent
          hosts={hosts}
          open={controller.open}
          shortcutLabel={controller.shortcutLabel}
        />
      </div>
    </div>
  );
}
