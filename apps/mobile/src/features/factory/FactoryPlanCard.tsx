import type { EnvironmentId, FactoryPlanActivityPayload } from "@t3tools/contracts";
import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";
import {
  readFactoryPlanContext,
  summarizeFactoryPlanCard,
} from "@t3tools/client-runtime/factory/plan-model";
import { resolvePlanApprovalState } from "@t3tools/client-runtime/factory/plan-approval";
import {
  defaultFactoryRoutes,
  readyFactoryRoutes,
  reconcileFactoryRouteSlots,
  validateFactoryRoutes,
  type FactoryRouteSlots,
} from "@t3tools/client-runtime/factory/routes";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { FactoryApprovedRoutes, FactoryRoutePicker } from "./FactoryRoutePicker";
import type { FactoryPlanApprovalContext } from "./useFactoryPlanApproval";
import { useFactorySnapshot } from "./useFactorySnapshot";

function FactoryPlanContext(props: {
  readonly environmentId: EnvironmentId;
  readonly digest: string;
  readonly renderMarkdown: (markdown: string) => ReactNode;
}) {
  const snapshot = useFactorySnapshot(props.environmentId, props.digest);
  // Keyed to the body itself: only a new plan text reparses it.
  const markdown = snapshot.status === "ready" ? snapshot.markdown : null;
  const context = useMemo(
    () => (markdown === null ? null : readFactoryPlanContext(markdown)),
    [markdown],
  );
  if (snapshot.status === "loading") {
    return (
      <View accessibilityLabel="Loading the plan's context" className="gap-2 py-1">
        <View className="h-3 w-full rounded-full bg-subtle" />
        <View className="h-3 w-2/3 rounded-full bg-subtle" />
      </View>
    );
  }
  if (snapshot.status === "failed") {
    return (
      <Text className="text-xs text-foreground-muted">The plan's text could not be loaded.</Text>
    );
  }
  if (context === null || context === "") return null;
  return props.renderMarkdown(context);
}

/**
 * The card's foot: the route per role and Approve, or the routes an approval
 * of these bytes carried. The rows are card-local until Approve queues them.
 */
function FactoryPlanApprovalSection(props: {
  readonly plan: FactoryPlanActivityPayload;
  readonly approval: FactoryPlanApprovalContext;
}) {
  const { plan, approval } = props;
  const state = useMemo(
    () => resolvePlanApprovalState(approval.approvals, plan),
    [approval.approvals, plan],
  );
  // Untouched rows follow the provider lists as they load; the first edit
  // takes them over.
  const [edited, setEdited] = useState<FactoryRouteSlots | null>(null);
  const defaults = useMemo(() => defaultFactoryRoutes(approval.providers), [approval.providers]);
  // Edits are held to the provider lists as they are now, so Approve never
  // sends a model or level the server stopped offering.
  const slots = useMemo(
    () => (edited === null ? defaults : reconcileFactoryRouteSlots(edited, approval.providers)),
    [edited, defaults, approval.providers],
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
  // The digest a queued or queueing Approve names: no second tap before the
  // queued message reads back as an approval.
  const [sentDigest, setSentDigest] = useState<string | null>(null);
  const sending = sentDigest === plan.digest;

  if (state.kind === "approved") {
    return (
      <View className="gap-2 border-t border-border pt-3">
        <Text className="font-t3-medium text-xs text-foreground-muted">Approved routes</Text>
        <FactoryApprovedRoutes
          routes={state.routes}
          routesBlock={state.routesBlock}
          providers={approval.providers}
        />
      </View>
    );
  }
  return (
    <View className="gap-3 border-t border-border pt-3">
      <View className="flex-row items-center gap-2">
        <Text className="font-t3-medium text-xs text-foreground-muted">Routes</Text>
        {state.kind === "changed" ? (
          <Text className="font-t3-medium text-xs text-foreground">Changed since approval</Text>
        ) : null}
      </View>
      <FactoryRoutePicker slots={slots} providers={approval.providers} onChange={setEdited} />
      {violations.map((violation) => (
        <Text key={violation} className="text-xs text-foreground-muted">
          {violation}
        </Text>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Approve"
        accessibilityState={{ disabled: routes === null || sending }}
        disabled={routes === null || sending}
        className="min-h-9 items-center justify-center self-end rounded-lg bg-primary px-4 active:opacity-65 disabled:opacity-50"
        onPress={() => {
          if (routes === null || sending) return;
          setSentDigest(plan.digest);
          void approval.approve(plan, routes).then((queued) => {
            if (!queued) setSentDigest(null);
          });
        }}
      >
        <Text className="font-t3-bold text-xs text-primary-foreground">Approve</Text>
      </Pressable>
    </View>
  );
}

/**
 * A plan the Software Factory presented to this thread. Only the Context
 * section renders inline; Open shows the whole plan on the Factory screen.
 * The feed supplies `renderMarkdown`, so the Context reads like its messages.
 */
export const FactoryPlanCard = memo(function FactoryPlanCard(props: {
  readonly plan: FactoryPlanActivityPayload;
  readonly environmentId: EnvironmentId;
  readonly onOpen: (() => void) | undefined;
  readonly renderMarkdown: (markdown: string) => ReactNode;
  /** Routes and Approve; without it the card only shows the plan. */
  readonly approval?: FactoryPlanApprovalContext | undefined;
}) {
  const summary = useMemo(() => summarizeFactoryPlanCard(props.plan), [props.plan]);
  const phaseKeys = useMemo(() => occurrenceKeys(summary.phaseLines), [summary]);
  return (
    <View className="my-2 min-w-0 gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="gap-0.5">
        <Text className="text-xs text-foreground-muted">Plan</Text>
        <Text className="font-t3-bold text-base text-foreground">{summary.title || "Plan"}</Text>
      </View>
      <FactoryPlanContext
        environmentId={props.environmentId}
        digest={props.plan.digest}
        renderMarkdown={props.renderMarkdown}
      />
      <View className="gap-1">
        <Text className="font-t3-medium text-xs text-foreground-muted tabular-nums">
          {summary.phaseCountLabel}
        </Text>
        {summary.phaseLines.map((line, index) => (
          <Text key={phaseKeys[index]} className="text-sm text-foreground" numberOfLines={2}>
            {line}
          </Text>
        ))}
      </View>
      {props.onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open"
          accessibilityHint="Shows the whole plan"
          className="min-h-9 items-center justify-center self-start rounded-lg border border-border bg-subtle px-3 active:opacity-65"
          onPress={props.onOpen}
        >
          <Text className="font-t3-bold text-xs text-foreground">Open</Text>
        </Pressable>
      ) : null}
      {props.approval ? (
        <FactoryPlanApprovalSection plan={props.plan} approval={props.approval} />
      ) : null}
    </View>
  );
});
