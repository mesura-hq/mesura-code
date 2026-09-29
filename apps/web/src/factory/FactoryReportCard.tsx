import type { EnvironmentId } from "@t3tools/contracts";
import type { FactoryReportTimelineItem } from "@t3tools/client-runtime/factory/plan-activities";
import { deriveFactoryReportCard } from "@t3tools/client-runtime/factory/report-view";
import { splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import { Maximize2Icon } from "lucide-react";
import { memo, useMemo } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "~/lib/utils";
import { useFactorySnapshot } from "./useFactorySnapshot";

/**
 * The report a Software Factory run wrote. Its prose (Context, What was
 * built) is `report.md` read by digest; its numbers come from the run's
 * `factory.run` activity, never the run stream, so a card on screen costs
 * the server nothing. Open shows the whole report in the Factory pane.
 */
export const FactoryReportCard = memo(function FactoryReportCard({
  factoryReport,
  environmentId,
  cwd,
  onOpen,
}: {
  factoryReport: FactoryReportTimelineItem;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  onOpen: ((runId: string) => void) | null;
}) {
  const { report } = factoryReport;
  const snapshot = useFactorySnapshot(environmentId, report.digest);
  const markdown = snapshot.status === "ready" ? snapshot.markdown : null;
  const document = useMemo(
    () => splitFactoryDocument(markdown ?? `# ${report.title}\n`),
    [markdown, report.title],
  );
  const card = deriveFactoryReportCard({
    report: document,
    summary: factoryReport.run?.run ?? null,
  });

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Factory report</Badge>
          <h3 className="truncate text-sm font-medium text-foreground">
            {card.title || report.title}
          </h3>
        </div>
        {onOpen ? (
          <Button size="xs" variant="outline" onClick={() => onOpen(report.runId)}>
            <Maximize2Icon aria-hidden="true" />
            Open
          </Button>
        ) : null}
      </div>
      <div className="mt-4 flex flex-col gap-3">
        {snapshot.status === "loading" ? (
          <div className="flex flex-col gap-2" aria-label="Loading the report">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : snapshot.status === "failed" ? (
          <p className="text-xs text-muted-foreground">The report's text could not be loaded.</p>
        ) : (
          <>
            {card.context === null ? null : (
              <ChatMarkdown text={card.context} cwd={cwd} environmentId={environmentId} />
            )}
            {card.built === null || card.built.bullets.length === 0 ? null : (
              <ChatMarkdown
                text={card.built.bullets.map((bullet) => `- ${bullet}`).join("\n")}
                cwd={cwd}
                environmentId={environmentId}
              />
            )}
          </>
        )}
      </div>
      {card.coverage === null && card.degraded === null ? null : (
        <p className="mt-3 flex flex-wrap gap-x-3 border-t border-border/60 pt-3 text-xs text-muted-foreground tabular-nums">
          {card.coverage === null ? null : <span>{card.coverage}</span>}
          {card.degraded === null ? null : (
            <span className={cn(card.hasDegraded && "text-destructive-foreground")}>
              {card.degraded}
            </span>
          )}
        </p>
      )}
    </div>
  );
});
