import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { FactoryReportTimelineItem } from "@t3tools/client-runtime/factory/plan-activities";
import {
  deriveFactoryReportCard,
  deriveFactoryReportView,
} from "@t3tools/client-runtime/factory/report-view";
import { splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import { Maximize2Icon } from "lucide-react";
import { memo, useMemo } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "~/lib/utils";
import { FactoryReportDocument } from "./FactoryReportDocument";
import { useFactoryRun } from "./useFactoryRun";
import { useFactorySnapshot } from "./useFactorySnapshot";

/**
 * The whole report in its chat card: `report.md` by digest plus the frame from the
 * run (captures, plan share, commands, trace). Until the run's stream arrives, or
 * with no thread to read it through, the card shows the prose's lead and summary.
 */
export const FactoryReportCard = memo(function FactoryReportCard({
  factoryReport,
  environmentId,
  cwd,
  threadRef = null,
  onOpen,
}: {
  factoryReport: FactoryReportTimelineItem;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  /** The thread whose file panel opens the report's file links; captures are read through it. */
  threadRef?: ScopedThreadRef | null;
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
    <div className="rounded-report border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Factory report</Badge>
          <h3 className="min-w-0 text-sm font-medium text-foreground">
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
      {card.coverage === null && card.degraded === null ? null : (
        <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
          {card.coverage === null ? null : <span>{card.coverage}</span>}
          {card.degraded === null ? null : (
            <span className={cn(card.hasDegraded && "text-destructive-foreground")}>
              {card.degraded}
            </span>
          )}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-3">
        {snapshot.status === "loading" ? (
          <div className="flex flex-col gap-2" aria-label="Loading the report">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : snapshot.status === "failed" ? (
          <p className="text-xs text-muted-foreground">The report's text could not be loaded.</p>
        ) : threadRef === null ? (
          <ReportLead card={card} environmentId={environmentId} cwd={cwd} threadRef={threadRef} />
        ) : (
          <FactoryReportWhole
            document={document}
            runId={report.runId}
            threadRef={threadRef}
            cwd={cwd}
            lead={
              <ReportLead
                card={card}
                environmentId={environmentId}
                cwd={cwd}
                threadRef={threadRef}
              />
            }
          />
        )}
      </div>
    </div>
  );
});

function ReportLead({
  card,
  environmentId,
  cwd,
  threadRef,
}: {
  card: ReturnType<typeof deriveFactoryReportCard>;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
}) {
  return (
    <>
      {card.context === null ? null : (
        <ChatMarkdown
          text={card.context}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef ?? undefined}
        />
      )}
      {card.built === null || card.built.bullets.length === 0 ? null : (
        <ChatMarkdown
          text={card.built.bullets.map((bullet) => `- ${bullet}`).join("\n")}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef ?? undefined}
        />
      )}
    </>
  );
}

/** The report with its frame, once the run's record arrives; the lead until then. */
function FactoryReportWhole({
  document,
  runId,
  threadRef,
  cwd,
  lead,
}: {
  document: ReturnType<typeof splitFactoryDocument>;
  runId: string;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
  lead: React.ReactNode;
}) {
  const stream = useFactoryRun(threadRef, runId);
  const state = stream.status === "ready" ? stream.item.state : null;
  const view = useMemo(
    () => (state === null ? null : deriveFactoryReportView({ report: document, state })),
    [document, state],
  );
  if (view === null || state === null) return <>{lead}</>;
  return (
    <FactoryReportDocument
      view={view}
      state={state}
      environmentId={threadRef.environmentId}
      cwd={cwd}
      threadRef={threadRef}
      variant="card"
    />
  );
}
