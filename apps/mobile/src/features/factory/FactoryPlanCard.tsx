import type { EnvironmentId, FactoryPlanActivityPayload } from "@t3tools/contracts";
import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";
import {
  readFactoryPlanContext,
  summarizeFactoryPlanCard,
} from "@t3tools/client-runtime/factory/plan-model";
import { memo, useMemo, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
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
 * A plan the Software Factory presented to this thread. Only the Context
 * section renders inline; Open shows the whole plan on the Factory screen.
 * The feed supplies `renderMarkdown`, so the Context reads like its messages.
 */
export const FactoryPlanCard = memo(function FactoryPlanCard(props: {
  readonly plan: FactoryPlanActivityPayload;
  readonly environmentId: EnvironmentId;
  readonly onOpen: (() => void) | undefined;
  readonly renderMarkdown: (markdown: string) => ReactNode;
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
    </View>
  );
});
