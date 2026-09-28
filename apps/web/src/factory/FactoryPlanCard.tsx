import type { EnvironmentId } from "@t3tools/contracts";
import { EllipsisIcon, Maximize2Icon } from "lucide-react";
import { memo, useMemo } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Skeleton } from "../components/ui/skeleton";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import type { FactoryPlanTimelineItem } from "@t3tools/client-runtime/factory/plan-activities";
import {
  readFactoryPlanContext,
  summarizeFactoryPlanCard,
} from "@t3tools/client-runtime/factory/plan-model";
import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";
import { useFactorySnapshot } from "./useFactorySnapshot";

function FactoryPlanContext({
  environmentId,
  digest,
  cwd,
}: {
  environmentId: EnvironmentId;
  digest: string;
  cwd: string | undefined;
}) {
  const snapshot = useFactorySnapshot(environmentId, digest);
  // Keyed to the body itself: only a new plan text reparses it.
  const markdown = snapshot.status === "ready" ? snapshot.markdown : null;
  const context = useMemo(
    () => (markdown === null ? null : readFactoryPlanContext(markdown)),
    [markdown],
  );
  if (snapshot.status === "loading") {
    return (
      <div className="flex flex-col gap-2" aria-label="Loading the plan's context">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  if (snapshot.status === "failed") {
    return <p className="text-xs text-muted-foreground">The plan's text could not be loaded.</p>;
  }
  if (context === null) return null;
  return <ChatMarkdown text={context} cwd={cwd} environmentId={environmentId} />;
}

/**
 * A plan the Software Factory presented to this thread. Only the Context
 * section renders inline; Open shows the whole plan in the Factory pane.
 */
export const FactoryPlanCard = memo(function FactoryPlanCard({
  factoryPlan,
  environmentId,
  cwd,
  onOpen,
}: {
  factoryPlan: FactoryPlanTimelineItem;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  onOpen: ((planId: string) => void) | null;
}) {
  const { plan } = factoryPlan;
  const summary = summarizeFactoryPlanCard(plan);
  const phaseLineKeys = occurrenceKeys(summary.phaseLines);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "plan path" });

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Factory plan</Badge>
          <h3 className="truncate text-sm font-medium text-foreground">{summary.title}</h3>
        </div>
        <div className="flex items-center gap-1.5">
          {onOpen ? (
            <Button size="xs" variant="outline" onClick={() => onOpen(factoryPlan.id)}>
              <Maximize2Icon aria-hidden="true" />
              Open
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={<Button aria-label="Factory plan actions" size="icon-xs" variant="outline" />}
            >
              <EllipsisIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => copyToClipboard(plan.planPath, undefined)}>
                {isCopied ? "Copied!" : "Copy plan path"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="mt-4">
        <FactoryPlanContext environmentId={environmentId} digest={plan.digest} cwd={cwd} />
      </div>
      <div className="mt-4 border-t border-border/60 pt-3">
        <p className="text-xs font-medium text-muted-foreground">{summary.phaseCountLabel}</p>
        <ol className="mt-1.5 flex list-decimal flex-col gap-0.5 pl-5 text-xs text-foreground/80">
          {summary.phaseLines.map((line, index) => (
            <li key={phaseLineKeys[index]}>{line}</li>
          ))}
        </ol>
      </div>
    </div>
  );
});
