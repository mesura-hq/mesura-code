import type { FactoryRunTimelineItem } from "@t3tools/client-runtime/factory/run-activities";
import {
  factoryPhaseMarkTone,
  factoryRunCardModel,
  type FactoryPhaseMarkTone,
} from "@t3tools/client-runtime/factory/run-presentation";
import { Maximize2Icon } from "lucide-react";
import { memo } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "~/lib/utils";

// The phase-mark vocabulary of the Agents panel's phase strip.
const MARK_CLASS_BY_TONE: Record<FactoryPhaseMarkTone, string> = {
  info: "border-info/40 text-info-foreground",
  success: "border-success/30 text-success-foreground",
  error: "border-destructive/40 text-destructive-foreground",
  warning: "border-warning/40 text-warning-foreground",
  neutral: "border-border/50 text-muted-foreground/70",
};

/** The clock time of the last event: absolute, so it never goes stale on screen. */
function eventClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A Software Factory run attached to this thread. The row is replaced in
 * place as the run's events arrive; nothing on it animates.
 */
export const FactoryRunCard = memo(function FactoryRunCard({
  factoryRun,
  onOpen,
}: {
  factoryRun: FactoryRunTimelineItem;
  onOpen: ((runId: string) => void) | null;
}) {
  const card = factoryRunCardModel(factoryRun.run);
  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Factory run</Badge>
          <Badge variant={card.status.tone}>{card.status.text}</Badge>
        </div>
        {onOpen ? (
          <Button size="xs" variant="outline" onClick={() => onOpen(factoryRun.run.runId)}>
            <Maximize2Icon aria-hidden="true" />
            Open
          </Button>
        ) : null}
      </div>
      <h3 className="mt-3 text-sm font-medium text-foreground">
        {card.request ?? factoryRun.run.runId}
      </h3>
      {card.phase === null ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          Phase {card.phase.index}/{card.phase.count}: {card.phase.title}
          {card.node === null ? null : ` · ${card.node}`}
        </p>
      )}
      {card.question === null ? null : (
        <p className="mt-3 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-xs text-foreground">
          {card.question}
        </p>
      )}
      {card.marks.length === 0 ? null : (
        <ol className="mt-3 flex flex-wrap gap-1">
          {card.marks.map((mark) => (
            <li
              key={mark.index}
              aria-label={`Phase ${mark.index}: ${mark.status}`}
              className={cn(
                "rounded-sm border px-1.5 py-0.5 font-mono text-[.65rem]",
                MARK_CLASS_BY_TONE[factoryPhaseMarkTone(mark.status)],
              )}
            >
              {mark.index}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
        <span>{card.returns}</span>
        <span>{card.cost}</span>
        {card.lastEventAt === null ? null : (
          <span>
            last event <time dateTime={card.lastEventAt}>{eventClock(card.lastEventAt)}</time>
          </span>
        )}
      </p>
    </div>
  );
});
