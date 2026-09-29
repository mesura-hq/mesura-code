import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  deriveFactoryPlanTimelineItems,
  type FactoryPlanTimelineItem,
} from "@t3tools/client-runtime/factory/plan-activities";
import { deriveLatestFactoryRunItem } from "@t3tools/client-runtime/factory/run-activities";
import { useMemo, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SegmentedControl } from "../../components/SegmentedControl";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { FactoryPlanDocument } from "./FactoryPlanDocument";
import { FactoryRunView } from "./FactoryRunView";
import { useFactorySnapshot } from "./useFactorySnapshot";

type FactoryRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  /** The `factory.plan` activity id; the thread's latest plan when absent or unknown. */
  readonly planId?: string;
  /** The tab to open on; the Plan tab when absent. */
  readonly tab?: "run";
  /** The run the Run tab shows; the thread's latest run when absent. */
  readonly runId?: string;
}>;

type FactoryTab = "plan" | "run" | "report";

// Run shows only for a thread with a run; Report arrives with the report view.
function factoryTabs(hasRun: boolean) {
  return [
    { value: "plan", label: "Plan" },
    { value: "run", label: "Run", disabled: !hasRun },
    { value: "report", label: "Report", disabled: true },
  ] as const satisfies ReadonlyArray<{
    readonly value: FactoryTab;
    readonly label: string;
    readonly disabled?: boolean;
  }>;
}

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
 * The Factory screen of one thread: the presented plan full-screen, and the
 * attached run on the Run tab. The thread comes from the route, like the
 * other thread screens; its plans and runs come from its `factory.plan` and
 * `factory.run` activities.
 */
export function FactoryRouteScreen(props: FactoryRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId, planId } = props.route.params;
  const threadDetail = useSelectedThreadDetail();
  const plans = useMemo(
    () => deriveFactoryPlanTimelineItems(threadDetail?.activities ?? []),
    [threadDetail?.activities],
  );
  const plan = selectFactoryPlan(plans, planId);
  const latestRun = useMemo(
    () => deriveLatestFactoryRunItem(threadDetail?.activities ?? []),
    [threadDetail?.activities],
  );
  const runId = props.route.params.runId ?? latestRun?.run.runId ?? null;
  const tabs = useMemo(() => factoryTabs(runId !== null), [runId]);
  const [pickedTab, setTab] = useState<FactoryTab>(props.route.params.tab ?? "plan");
  const tab = pickedTab === "run" && runId === null ? "plan" : pickedTab;

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
        <SegmentedControl options={tabs} selected={tab} onSelect={setTab} role="tab" />
        {tab === "run" && runId !== null ? (
          <FactoryRunView
            environmentId={EnvironmentId.make(environmentId)}
            threadId={ThreadId.make(threadId)}
            runId={runId}
          />
        ) : plan === null ? (
          <FactoryScreenMessage text="This thread has no plan yet." />
        ) : (
          <FactoryPlanBody environmentId={EnvironmentId.make(environmentId)} plan={plan} />
        )}
      </ScrollView>
    </View>
  );
}
