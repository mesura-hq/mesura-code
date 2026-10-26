import type { FactoryRunRole, FactoryRunSummary, ScopedThreadRef } from "@t3tools/contracts";
import { factoryNodeDisplayName } from "@t3tools/client-runtime/factory/run-presentation";
import {
  decodeFactoryTraceStrip,
  deriveFactoryRunTrace,
  encodeFactoryTraceStrip,
  factoryTraceDurationText,
  factoryTraceTokenText,
  factoryTraceUsdText,
  type FactoryTrace,
  type FactoryTracePhase,
  type FactoryTraceStop,
  type FactoryTraceStripKind,
  type FactoryTraceTurn,
} from "@t3tools/shared/factoryRunTrace";
import { ChevronRightIcon } from "lucide-react";
import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Spinner } from "../components/ui/spinner";
import { cn } from "~/lib/utils";
import { useFactoryRun } from "./useFactoryRun";

const ROLE_FILL: Record<FactoryRunRole, string> = {
  implementer: "bg-orange-500/85",
  verifier: "bg-sky-500/85",
  reviewer: "bg-violet-500/85",
};

const WAITING_FILL =
  "bg-[repeating-linear-gradient(45deg,var(--warning)_0_4px,transparent_4px_8px)] opacity-70";
const COORDINATOR_FILL = "bg-foreground/12";

const STRIP_FILL: Record<Exclude<FactoryTraceStripKind, "idle">, string> = {
  ...ROLE_FILL,
  waiting: WAITING_FILL,
  coordinator: COORDINATOR_FILL,
};

/** A segment's place on a track, as fractions of its width. */
function placed(start: number, width: number): CSSProperties {
  return { left: `${start * 100}%`, width: `max(2px, ${width * 100}%)` };
}

function spanOf(from: number, to: number, origin: number, length: number): CSSProperties {
  return placed((from - origin) / length, (to - from) / length);
}

function Track({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative h-3 overflow-hidden rounded-sm bg-muted/60", className)}>
      {children}
    </div>
  );
}

function turnSpend(turn: FactoryTraceTurn): string {
  if (turn.costUsd !== null) return factoryTraceUsdText(turn.costUsd);
  if (turn.tokens !== null) return `${factoryTraceTokenText(turn.tokens)} tok`;
  return "—";
}

function spendText(costUsd: number, tokens: number): string {
  const parts: string[] = [];
  if (costUsd > 0) parts.push(factoryTraceUsdText(costUsd));
  if (tokens > 0) parts.push(`${factoryTraceTokenText(tokens)} tok`);
  return parts.join(" + ") || "—";
}

/**
 * The run on one track, from the summary's strip: no run stream, so every run
 * card can draw it. Nothing on it animates; it is redrawn when the run's
 * summary changes.
 */
export const FactoryTraceStrip = memo(function FactoryTraceStrip({
  trace,
}: {
  trace: NonNullable<FactoryRunSummary["trace"]>;
}) {
  const segments = useMemo(() => decodeFactoryTraceStrip(trace.strip), [trace.strip]);
  return (
    <div className="flex flex-col gap-1">
      <Track className="h-2.5">
        {segments.map((segment) => (
          <div
            key={segment.start}
            className={cn(
              "absolute inset-y-0",
              STRIP_FILL[segment.kind as Exclude<FactoryTraceStripKind, "idle">],
            )}
            style={placed(segment.start, segment.width)}
          />
        ))}
      </Track>
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
        <span>{factoryTraceDurationText(trace.wallMs)}</span>
        <span>agents {factoryTraceDurationText(trace.agentMs)}</span>
        {trace.waitingMs > 0 ? (
          <span className="text-warning-foreground">
            waiting for you {factoryTraceDurationText(trace.waitingMs)}
          </span>
        ) : null}
      </p>
    </div>
  );
});

function Legend() {
  const swatches = [
    ...(Object.keys(ROLE_FILL) as FactoryRunRole[]).map((role) => ({
      label: role,
      fill: ROLE_FILL[role],
    })),
    { label: "waiting for you", fill: WAITING_FILL },
    { label: "coordinator, checks", fill: COORDINATOR_FILL },
  ];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {swatches.map((swatch) => (
        <span key={swatch.label} className="flex items-center gap-1.5">
          <i className={cn("size-2.5 rounded-[2px]", swatch.fill)} />
          {swatch.label}
        </span>
      ))}
    </div>
  );
}

/** Where the wall clock went: four numbers that add up to it. */
function ClockCells({ trace }: { trace: FactoryTrace }) {
  const { totals } = trace;
  const cells = [
    { label: trace.live ? "so far" : "wall clock", ms: totals.wallMs },
    { label: "agents working", ms: totals.agentMs },
    { label: "waiting for you", ms: totals.waitingMs },
    { label: "coordinator, checks", ms: totals.coordinatorMs },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((cell) => (
        <div key={cell.label} className="rounded-lg border border-border/70 px-2.5 py-1.5">
          <dt className="text-[11px] text-muted-foreground">{cell.label}</dt>
          <dd className="text-sm font-medium text-foreground tabular-nums">
            {factoryTraceDurationText(cell.ms)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StopLane({
  stop,
  trace,
  length,
}: {
  stop: FactoryTraceStop;
  trace: FactoryTrace;
  length: number;
}) {
  const end = stop.endMs ?? trace.endMs;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-warning-foreground">Stopped: {stop.question}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {factoryTraceDurationText(end - stop.startMs)}
        </span>
      </div>
      <Track>
        <div
          className={cn("absolute inset-y-0", WAITING_FILL)}
          style={spanOf(stop.startMs, end, trace.startMs, length)}
        />
      </Track>
    </li>
  );
}

/** A phase's role turns, each on the phase's own axis, labelled by the step it ran in. */
function PhaseTurns({ phase, endMs }: { phase: FactoryTracePhase; endMs: number }) {
  if (phase.turns.length === 0) {
    return <p className="py-1 text-xs text-muted-foreground">No role has been dispatched yet.</p>;
  }
  const origin = phase.startMs ?? phase.turns[0]!.startMs;
  const length = Math.max(1, (phase.endMs ?? endMs) - origin);
  return (
    <ol className="flex flex-col gap-1.5 py-1.5" aria-label={`Turns of phase ${phase.index}`}>
      {phase.turns.map((turn) => (
        <li key={turn.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <i className={cn("size-2 shrink-0 rounded-[2px]", ROLE_FILL[turn.role])} />
            <span className="shrink-0 text-foreground">
              {turn.node === null ? turn.role : factoryNodeDisplayName(turn.node)}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {turn.node === null ? turn.turn : `${turn.role} ${turn.turn}`}
            </span>
            <span className="truncate text-muted-foreground">{turn.model}</span>
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {turn.endMs === null ? "running · " : null}
            {factoryTraceDurationText((turn.endMs ?? endMs) - turn.startMs)} · {turnSpend(turn)}
          </span>
          <Track className="col-span-2 h-1.5">
            <div
              className={cn("absolute inset-y-0 rounded-[2px]", ROLE_FILL[turn.role])}
              style={spanOf(turn.startMs, turn.endMs ?? endMs, origin, length)}
            />
          </Track>
        </li>
      ))}
    </ol>
  );
}

function PhaseLane({
  phase,
  trace,
  length,
  open,
  onToggle,
  detail,
}: {
  phase: FactoryTracePhase;
  trace: FactoryTrace;
  length: number;
  open: boolean;
  onToggle: () => void;
  detail: ReactNode;
}) {
  const started = phase.startMs !== null;
  const end = phase.endMs ?? trace.endMs;
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Phase ${phase.index}: ${phase.status} — ${phase.title}`}
        disabled={!started}
        onClick={onToggle}
        className="flex flex-col gap-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
      >
        <span className="flex items-baseline justify-between gap-3 text-xs">
          <span className="flex min-w-0 items-baseline gap-1">
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 translate-y-0.5 text-muted-foreground",
                open && "rotate-90",
                !started && "opacity-0",
              )}
            />
            <span className={cn("min-w-0", started ? "text-foreground" : "text-muted-foreground")}>
              {phase.index}. {phase.title}
              {phase.status === "degraded" ? (
                <span className="text-warning-foreground"> · degraded</span>
              ) : null}
            </span>
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {started
              ? `${factoryTraceDurationText(end - phase.startMs!)} · ${spendText(phase.costUsd, phase.tokens)}`
              : "pending"}
          </span>
        </span>
        <Track>
          {started ? (
            <div
              className={cn("absolute inset-y-0", COORDINATOR_FILL)}
              style={spanOf(phase.startMs!, end, trace.startMs, length)}
            />
          ) : null}
          {phase.turns.map((turn) => (
            <div
              key={turn.key}
              className={cn("absolute inset-y-0 rounded-[2px]", ROLE_FILL[turn.role])}
              style={spanOf(turn.startMs, turn.endMs ?? trace.endMs, trace.startMs, length)}
            />
          ))}
        </Track>
      </button>
      {open ? (
        <div className="ml-4 flex flex-col gap-3 border-l border-border/60 pl-3">
          <PhaseTurns phase={phase} endMs={trace.endMs} />
          {detail}
        </div>
      ) : null}
    </li>
  );
}

function RoleTotals({ trace }: { trace: FactoryTrace }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
      {trace.totals.byRole
        .filter((row) => row.turns > 0)
        .map((row) => (
          <div key={row.role} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-1.5">
              <i className={cn("size-2 rounded-[2px]", ROLE_FILL[row.role])} />
              {row.role}
              <span className="text-muted-foreground">· {row.turns} turns</span>
            </span>
            <span className="text-muted-foreground tabular-nums">
              {factoryTraceDurationText(row.ms)} · {spendText(row.costUsd, row.tokens)}
            </span>
          </div>
        ))}
    </div>
  );
}

/**
 * The whole run as a trace: the time split, one lane per phase on the run's
 * axis, stops where they happened, and the spend per role. A lane opens onto
 * its turns and, when given, the phase's own detail. With `selectedPhase` and
 * `onSelectPhase` the open lane is the caller's; otherwise each lane toggles.
 */
export const FactoryRunTrace = memo(function FactoryRunTrace({
  trace,
  selectedPhase,
  onSelectPhase,
  phaseDetail,
}: {
  trace: FactoryTrace;
  selectedPhase?: number | null;
  onSelectPhase?: (phase: number) => void;
  phaseDetail?: (phase: number) => ReactNode;
}) {
  const [openPhases, setOpenPhases] = useState<ReadonlySet<number>>(() => new Set());
  const controlled = onSelectPhase !== undefined;
  const length = Math.max(1, trace.endMs - trace.startMs);
  const strip = useMemo(
    () => ({
      strip: encodeFactoryTraceStrip(trace),
      wallMs: trace.totals.wallMs,
      agentMs: trace.totals.agentMs,
      waitingMs: trace.totals.waitingMs,
    }),
    [trace],
  );
  return (
    <div className="flex flex-col gap-3">
      <FactoryTraceStrip trace={strip} />
      <ClockCells trace={trace} />
      <Legend />
      <ol className="flex flex-col gap-2.5" aria-label="Phases">
        {trace.phases.map((phase) => {
          const open = controlled ? selectedPhase === phase.index : openPhases.has(phase.index);
          return (
            <Fragment key={phase.index}>
              <PhaseLane
                phase={phase}
                trace={trace}
                length={length}
                open={open}
                onToggle={() => {
                  if (controlled) {
                    onSelectPhase(phase.index);
                    return;
                  }
                  setOpenPhases((current) => {
                    const next = new Set(current);
                    if (!next.delete(phase.index)) next.add(phase.index);
                    return next;
                  });
                }}
                detail={open ? phaseDetail?.(phase.index) : null}
              />
              {trace.stops
                .filter((stop) => stop.phase === phase.index)
                .map((stop) => (
                  <StopLane key={stop.startMs} stop={stop} trace={trace} length={length} />
                ))}
            </Fragment>
          );
        })}
        {trace.stops
          .filter(
            (stop) =>
              stop.phase === null || !trace.phases.some((phase) => phase.index === stop.phase),
          )
          .map((stop) => (
            <StopLane key={stop.startMs} stop={stop} trace={trace} length={length} />
          ))}
      </ol>
      <div className="flex justify-between text-[10.5px] text-muted-foreground tabular-nums">
        <span>0</span>
        <span>{factoryTraceDurationText(length / 2)}</span>
        <span>{factoryTraceDurationText(length)}</span>
      </div>
      <RoleTotals trace={trace} />
    </div>
  );
});

/** A live run's trace is redrawn once a minute between events; a finished one never. */
export function useFactoryTraceClock(live: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return nowMs;
}

/**
 * The trace of a run read from its stream. Mounting it subscribes to the run,
 * so a card mounts it only while its trace is open.
 */
export function FactoryRunTraceFromStream({
  threadRef,
  runId,
}: {
  threadRef: ScopedThreadRef;
  runId: string;
}) {
  const stream = useFactoryRun(threadRef, runId);
  const state = stream.status === "ready" ? stream.item.state : null;
  const nowMs = useFactoryTraceClock(state !== null && state.finishedAt === null);
  const trace = useMemo(
    () => (state === null ? null : deriveFactoryRunTrace(state, nowMs)),
    [state, nowMs],
  );
  if (stream.status === "loading") {
    return (
      <div className="flex justify-center py-3">
        <Spinner />
      </div>
    );
  }
  if (trace === null) {
    return <p className="text-xs text-muted-foreground">The run's trace could not be loaded.</p>;
  }
  return <FactoryRunTrace trace={trace} />;
}
