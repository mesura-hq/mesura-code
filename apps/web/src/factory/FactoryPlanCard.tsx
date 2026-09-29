import type {
  EnvironmentId,
  FactoryPlanActivityPayload,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  defaultFactoryRoutes,
  readyFactoryRoutes,
  reconcileFactoryRouteSlots,
  validateFactoryRoutes,
  type FactoryRouteSlots,
} from "@t3tools/client-runtime/factory/routes";
import { EllipsisIcon, Maximize2Icon } from "lucide-react";
import { memo, useMemo, useState } from "react";

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
import { FactoryApprovedRoutes, FactoryRoutePicker } from "./FactoryRoutePicker";
import { useFactoryPlanApproval } from "./useFactoryPlanApproval";
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
 * The card's foot: the route per role and Approve, or the routes an approval
 * of these bytes carried. The rows are card-local until Approve sends them.
 */
function FactoryPlanApprovalSection({
  threadRef,
  plan,
}: {
  threadRef: ScopedThreadRef;
  plan: FactoryPlanActivityPayload;
}) {
  const { state, providers, approve, sending } = useFactoryPlanApproval(threadRef, plan);
  // Untouched rows follow the provider lists as they load; the first edit
  // takes them over.
  const [edited, setEdited] = useState<FactoryRouteSlots | null>(null);
  const defaults = useMemo(() => defaultFactoryRoutes(providers), [providers]);
  // Edits are held to the provider lists as they are now, so Approve never
  // sends a model or level the server stopped offering.
  const slots = useMemo(
    () => (edited === null ? defaults : reconcileFactoryRouteSlots(edited, providers)),
    [edited, defaults, providers],
  );
  const routes = readyFactoryRoutes(slots);
  const { implementer, reviewer, verifier } = slots;
  const violations =
    implementer.status === "ready" && reviewer.status === "ready" && verifier.status === "ready"
      ? validateFactoryRoutes({
          implementer: implementer.route,
          reviewer: reviewer.route,
          verifier: verifier.route,
        })
      : [];

  if (state.kind === "approved") {
    return (
      <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Approved</Badge>
          <p className="text-xs text-muted-foreground">Routes for this build</p>
        </div>
        <FactoryApprovedRoutes
          routes={state.routes}
          routesBlock={state.routesBlock}
          providers={providers}
        />
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">Routes</p>
        {state.kind === "changed" ? <Badge variant="outline">Changed since approval</Badge> : null}
      </div>
      <FactoryRoutePicker slots={slots} providers={providers} onChange={setEdited} />
      {violations.map((violation) => (
        <p key={violation} className="text-xs text-destructive">
          {violation}
        </p>
      ))}
      <div className="flex justify-end">
        <Button
          size="xs"
          disabled={routes === null || sending}
          onClick={() => {
            if (routes !== null) void approve(routes);
          }}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

/**
 * A plan the Software Factory presented to this thread. Only the Context
 * section renders inline; Open shows the whole plan in the Factory pane.
 */
export const FactoryPlanCard = memo(function FactoryPlanCard({
  factoryPlan,
  environmentId,
  cwd,
  threadRef,
  onOpen,
}: {
  factoryPlan: FactoryPlanTimelineItem;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  /** The thread the plan was presented to; without one the card has no Approve. */
  threadRef: ScopedThreadRef | null;
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
      {threadRef === null ? null : <FactoryPlanApprovalSection threadRef={threadRef} plan={plan} />}
    </div>
  );
});
