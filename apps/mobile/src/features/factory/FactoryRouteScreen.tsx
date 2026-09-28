import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import {
  deriveFactoryPlanTimelineItems,
  type FactoryPlanTimelineItem,
} from "@t3tools/client-runtime/factory/plan-activities";
import { useMemo, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SegmentedControl } from "../../components/SegmentedControl";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { FactoryPlanDocument } from "./FactoryPlanDocument";
import { useFactorySnapshot } from "./useFactorySnapshot";

type FactoryRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  /** The `factory.plan` activity id; the thread's latest plan when absent or unknown. */
  readonly planId?: string;
}>;

type FactoryTab = "plan" | "run" | "report";

// Run and Report arrive with the run view; until then they show, disabled.
const FACTORY_TABS = [
  { value: "plan", label: "Plan" },
  { value: "run", label: "Run", disabled: true },
  { value: "report", label: "Report", disabled: true },
] as const satisfies ReadonlyArray<{
  readonly value: FactoryTab;
  readonly label: string;
  readonly disabled?: boolean;
}>;

function selectFactoryPlan(
  plans: ReadonlyArray<FactoryPlanTimelineItem>,
  planId: string | undefined,
): FactoryPlanTimelineItem | null {
  const named = planId === undefined ? undefined : plans.find((plan) => plan.id === planId);
  return named ?? plans[plans.length - 1] ?? null;
}

function FactoryScreenMessage(props: { readonly text: string }) {
  return <Text className="py-6 text-center text-sm text-foreground-muted">{props.text}</Text>;
}

function FactoryPlanBody(props: {
  readonly environmentId: EnvironmentId;
  readonly plan: FactoryPlanTimelineItem;
}) {
  const snapshot = useFactorySnapshot(props.environmentId, props.plan.plan.digest);
  if (snapshot.status === "loading") return <FactoryScreenMessage text="Loading the plan…" />;
  if (snapshot.status === "failed") {
    return <FactoryScreenMessage text="The plan's text could not be loaded." />;
  }
  return <FactoryPlanDocument markdown={snapshot.markdown} />;
}

/**
 * The Factory screen of one thread: the presented plan full-screen. The
 * thread comes from the route, like the other thread screens; its plans come
 * from the thread's `factory.plan` activities.
 */
export function FactoryRouteScreen(props: FactoryRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, planId } = props.route.params;
  const threadDetail = useSelectedThreadDetail();
  const plans = useMemo(
    () => deriveFactoryPlanTimelineItems(threadDetail?.activities ?? []),
    [threadDetail?.activities],
  );
  const plan = selectFactoryPlan(plans, planId);
  const [tab, setTab] = useState<FactoryTab>("plan");

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Factory" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SegmentedControl options={FACTORY_TABS} selected={tab} onSelect={setTab} role="tab" />
        {plan === null ? (
          <FactoryScreenMessage text="This thread has no plan yet." />
        ) : (
          <FactoryPlanBody environmentId={EnvironmentId.make(environmentId)} plan={plan} />
        )}
      </ScrollView>
    </View>
  );
}
