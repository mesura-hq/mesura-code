import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  deriveFactoryTimelineItems,
  findFactoryReportItem,
  type FactoryPlanTimelineItem,
  type FactoryReportTimelineItem,
} from "@t3tools/client-runtime/factory/plan-activities";
import { deriveFactoryReportView } from "@t3tools/client-runtime/factory/report-view";
import { splitFactoryDocument } from "@t3tools/shared/factoryDocument";
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
import { FactoryReportDocument } from "./FactoryReportDocument";
import { FactoryRunView } from "./FactoryRunView";
import { useFactoryRun } from "./useFactoryRun";
import { useFactorySnapshot } from "./useFactorySnapshot";

type FactoryRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  /** The `factory.plan` activity id; the thread's latest plan when absent or unknown. */
  readonly planId?: string;
  /** The tab to open on; the Plan tab when absent. */
  readonly tab?: "run" | "report";
  /** The run the Run and Report tabs show; the thread's latest run when absent. */
  readonly runId?: string;
}>;

type FactoryTab = "plan" | "run" | "report";

// Run opens only for a thread with a run, Report only once that run wrote its report.
function factoryTabs(hasRun: boolean, hasReport: boolean) {
  return [
    { value: "plan", label: "Plan" },
    { value: "run", label: "Run", disabled: !hasRun },
    { value: "report", label: "Report", disabled: !hasReport },
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

/** The report's frame from the run stream, held open only while the screen is focused. */
function FactoryReportStream(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly report: FactoryReportTimelineItem;
  readonly markdown: string;
}) {
  const stream = useFactoryRun(props.environmentId, props.threadId, props.report.report.runId);
  const state = stream.status === "ready" ? stream.item.state : null;
  const document = useMemo(() => splitFactoryDocument(props.markdown), [props.markdown]);
  const view = useMemo(
    () => (state === null ? null : deriveFactoryReportView({ report: document, state })),
    [document, state],
  );
  if (view !== null) return <FactoryReportDocument view={view} />;
  if (stream.status === "failed") {
    return <FactoryScreenMessage text="The run's record could not be loaded." />;
  }
  return <FactoryScreenMessage text="Loading the report…" />;
}

function FactoryReportBody(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly report: FactoryReportTimelineItem;
}) {
  const focused = useIsFocused();
  const snapshot = useFactorySnapshot(props.environmentId, props.report.report.digest);
  if (snapshot.status === "loading") return <FactoryScreenMessage text="Loading the report…" />;
  if (snapshot.status === "failed") {
    return <FactoryScreenMessage text="The report's text could not be loaded." />;
  }
  if (!focused) return null;
  return <FactoryReportStream {...props} markdown={snapshot.markdown} />;
}

/**
 * The Factory screen of one thread: the presented plan full-screen, the
 * attached run on the Run tab, and the run's report on the Report tab. The thread comes from the route, like the
 * other thread screens; its plans and runs come from its `factory.plan` and
 * `factory.run` activities.
 */
export function FactoryRouteScreen(props: FactoryRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId, planId } = props.route.params;
  const threadDetail = useSelectedThreadDetail();
  const factoryItems = useMemo(
    () => deriveFactoryTimelineItems(threadDetail?.activities ?? []),
    [threadDetail?.activities],
  );
  const plans = useMemo(
    () => factoryItems.filter((item): item is FactoryPlanTimelineItem => item.kind === "plan"),
    [factoryItems],
  );
  const plan = selectFactoryPlan(plans, planId);
  const latestRun = useMemo(
    () => deriveLatestFactoryRunItem(threadDetail?.activities ?? []),
    [threadDetail?.activities],
  );
  const runId = props.route.params.runId ?? latestRun?.run.runId ?? null;
  const report = findFactoryReportItem(factoryItems, runId);
  const tabs = useMemo(() => factoryTabs(runId !== null, report !== null), [runId, report]);
  const [pickedTab, setTab] = useState<FactoryTab>(props.route.params.tab ?? "plan");
  const tab =
    (pickedTab === "run" && runId === null) || (pickedTab === "report" && report === null)
      ? "plan"
      : pickedTab;

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
        {tab === "report" && report !== null ? (
          <FactoryReportBody
            environmentId={EnvironmentId.make(environmentId)}
            threadId={ThreadId.make(threadId)}
            report={report}
          />
        ) : tab === "run" && runId !== null ? (
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
