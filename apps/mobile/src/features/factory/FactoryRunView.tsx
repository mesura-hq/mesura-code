import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import {
  isFactoryRunFinished,
  type EnvironmentId,
  type FactoryRunState,
  type FactoryRunStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import { factoryEventClock } from "@t3tools/client-runtime/factory/run-presentation";
import {
  deriveFactoryRunTotals,
  FACTORY_SPINE_NODE_TONE,
  factoryRailTone,
  factoryReturnDestination,
  factoryRunFilePath,
  type FactoryPhaseDetail,
  type FactoryPhaseView,
  type FactoryRoleSessionRow,
  type FactorySpineView,
} from "@t3tools/client-runtime/factory/run-view";
import { readFactoryRunStreamState } from "@t3tools/client-runtime/state/factory";
import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { factoryEnvironment } from "../../state/factory";
import { basename, fileRoutePathSegments } from "../files/filePath";
import {
  deriveFactoryRunSections,
  type FactoryPhaseOverrides,
  type FactoryRunSection,
  type FactoryRunSections,
} from "./factoryRunSections";
import { FACTORY_MARK_BY_TONE, FACTORY_TEXT_BY_TONE } from "./factoryTones";

type OpenFile = (path: string) => void;

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="font-t3-medium text-xs uppercase text-foreground-muted">{props.title}</Text>
      {props.children}
    </View>
  );
}

function RunMessage(props: { readonly text: string }) {
  return <Text className="py-6 text-center text-sm text-foreground-muted">{props.text}</Text>;
}

/** The phone's clock, ticking once a second while `live`; frozen otherwise. */
function useSecondClock(live: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  return nowMs;
}

/** Elapsed, waiting and cost. The only part of the tab that repaints with the clock. */
function FactoryRunTotals(props: { readonly state: FactoryRunState }) {
  const live = !isFactoryRunFinished(props.state.status);
  const totals = deriveFactoryRunTotals(props.state, useSecondClock(live));
  return (
    <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
      <Text className="text-xs text-foreground-muted tabular-nums">{`elapsed ${totals.elapsed}`}</Text>
      <Text className="text-xs text-foreground-muted tabular-nums">{`waiting ${totals.waiting}`}</Text>
      <Text className="text-xs text-foreground-muted tabular-nums">{totals.cost}</Text>
      {totals.costIsFloor ? (
        <Text
          accessibilityLabel="floor: Codex turns report tokens, not dollars, so the dollar figure is a lower bound"
          className={cn("font-t3-medium text-xs", FACTORY_TEXT_BY_TONE.warning)}
        >
          floor
        </Text>
      ) : null}
    </View>
  );
}

const FactorySpine = memo(function FactorySpine(props: { readonly spine: FactorySpineView }) {
  return (
    <View className="gap-2">
      {props.spine.stages.map((stage) => (
        <View key={stage.stage} className="gap-1">
          <Text className="text-xs text-foreground-muted">{stage.stage}</Text>
          <View className="flex-row flex-wrap gap-1.5">
            {stage.nodes.map((node) => (
              <View
                key={node.node}
                accessibilityLabel={`${node.label}: ${node.status}`}
                className="rounded-md border border-border px-1.5 py-0.5"
              >
                <Text
                  className={cn(
                    "text-xs",
                    node.status === "current" && "font-t3-bold",
                    FACTORY_MARK_BY_TONE[FACTORY_SPINE_NODE_TONE[node.status]],
                  )}
                >
                  {node.status === "done"
                    ? `✓ ${node.label}`
                    : node.status === "current"
                      ? `● ${node.label}`
                      : node.label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ))}
      {props.spine.returns.length === 0 ? null : (
        <Section title="Returns">
          {props.spine.returns.map((edge) => (
            <Text key={edge.text} className="text-xs text-foreground">
              {edge.text}
              <Text className="text-xs text-foreground-muted">{` ${factoryReturnDestination(edge)}`}</Text>
            </Text>
          ))}
        </Section>
      )}
    </View>
  );
});

function FileChip(props: { readonly path: string; readonly onOpenFile: OpenFile }) {
  const { path, onOpenFile } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${path}`}
      className="self-start rounded-md border border-border bg-subtle px-2 py-1 active:opacity-65"
      onPress={() => onOpenFile(path)}
    >
      <Text className="font-mono text-xs text-foreground" numberOfLines={1}>
        {basename(path)}
      </Text>
    </Pressable>
  );
}

// One row per role session. A row the stream did not change keeps its
// identity (the shared model's `previous`), so it does not re-render.
const FactoryRoleRow = memo(function FactoryRoleRow(props: {
  readonly row: FactoryRoleSessionRow;
  readonly onOpenFile: OpenFile;
}) {
  const { row } = props;
  return (
    <View className="gap-1 rounded-lg border border-border px-3 py-2">
      <View className="flex-row flex-wrap items-center gap-x-2">
        <Text className="font-t3-medium text-sm capitalize text-foreground">{row.role}</Text>
        <Text
          className={cn(
            "text-xs",
            row.status === "running" ? FACTORY_TEXT_BY_TONE.info : "text-foreground-muted",
          )}
        >
          {row.status}
        </Text>
        <Text className="text-xs text-foreground-muted tabular-nums">
          {`${row.turnCount} ${row.turnCount === 1 ? "turn" : "turns"}`}
          {row.cost === null ? "" : ` · ${row.cost}`}
        </Text>
      </View>
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {`${row.harness} · ${row.model}`}
      </Text>
      <Text className="font-mono text-xs text-foreground-tertiary" numberOfLines={1}>
        {`session ${row.sessionId ?? "not reported yet"}`}
      </Text>
      {row.status === "running" ? (
        <Text className="text-xs text-foreground-muted tabular-nums">
          {[
            `${row.toolCalls ?? 0} tool calls`,
            row.lastTool === null ? null : `last ${row.lastTool}`,
            row.lastActivityAt === null ? null : `active ${factoryEventClock(row.lastActivityAt)}`,
          ]
            .filter((part) => part !== null)
            .join("  ·  ")}
        </Text>
      ) : null}
      {row.turns.map((turn) => (
        <View key={turn.turn} className="flex-row flex-wrap items-center gap-1.5">
          <Text className="text-xs text-foreground-muted tabular-nums">{`Turn ${turn.turn}`}</Text>
          <FileChip path={turn.promptFile} onOpenFile={props.onOpenFile} />
          {turn.reportFile === null ? (
            <Text className="text-xs text-foreground-muted">running</Text>
          ) : (
            <FileChip path={turn.reportFile} onOpenFile={props.onOpenFile} />
          )}
        </View>
      ))}
    </View>
  );
});

const FactoryPhaseRecord = memo(function FactoryPhaseRecord(props: {
  readonly detail: FactoryPhaseDetail;
  readonly onOpenRunFile: OpenFile;
}) {
  const { detail } = props;
  return (
    <>
      {detail.verdicts.length === 0 ? null : (
        <Section title="Verdicts">
          {detail.verdicts.map((verdict) => (
            <Text key={verdict.pass} className="text-xs text-foreground">
              {`${verdict.label} ${verdict.verdict.replaceAll("_", " ")}`}
              <Text className="text-xs text-foreground-muted">{` — ${verdict.deciding}`}</Text>
            </Text>
          ))}
        </Section>
      )}
      {detail.findings.length === 0 ? null : (
        <Section title="Findings">
          {detail.findings.map((finding) => (
            <Text key={finding.id} className="text-xs text-foreground">
              {`${finding.id} ${finding.severity} ${finding.title}`}
              <Text className="text-xs text-foreground-muted">
                {` — ${finding.disposition ?? "open"}${
                  finding.reason === null ? "" : `: ${finding.reason}`
                }`}
              </Text>
            </Text>
          ))}
        </Section>
      )}
      {detail.checks.length === 0 ? null : (
        <Section title="Checks">
          {detail.checks.map((check) => (
            <View key={`${check.stage}:${check.at}`} className="gap-0.5">
              <Text className="text-xs text-foreground-muted">{check.stage}</Text>
              {check.results.map((result) => (
                <Text key={result.command} className="font-mono text-xs text-foreground">
                  {`${result.command} `}
                  <Text
                    className={cn(
                      "text-xs tabular-nums",
                      FACTORY_TEXT_BY_TONE[result.exit === 0 ? "success" : "error"],
                    )}
                  >
                    {`exit ${result.exit}`}
                  </Text>
                </Text>
              ))}
            </View>
          ))}
        </Section>
      )}
      {detail.deviations.length === 0 ? null : (
        <Section title="Deviations">
          {detail.deviations.map((deviation) => (
            <View key={`${deviation.kind}:${deviation.path}`} className="gap-0.5">
              <FileChip path={deviation.path} onOpenFile={props.onOpenRunFile} />
              <Text className="text-xs text-foreground-muted">
                {`${deviation.kind} — ${deviation.reason}`}
              </Text>
            </View>
          ))}
        </Section>
      )}
      {detail.degraded.length === 0 ? null : (
        <Section title="Degraded">
          {detail.degraded.map((cause) => (
            <Text key={cause} className={cn("text-xs", FACTORY_TEXT_BY_TONE.error)}>
              {cause}
            </Text>
          ))}
        </Section>
      )}
      {detail.commit === null ? null : (
        <Section title="Commit">
          {"hash" in detail.commit ? (
            <Text className="text-xs text-foreground">
              <Text className="font-mono text-xs text-foreground">{detail.commit.hash}</Text>
              {` ${detail.commit.subject}`}
            </Text>
          ) : (
            <Text className={cn("text-xs", FACTORY_TEXT_BY_TONE.error)}>
              {`blocked: ${detail.commit.blocked}`}
            </Text>
          )}
        </Section>
      )}
    </>
  );
});

const FactoryPhaseBody = memo(function FactoryPhaseBody(props: {
  readonly view: FactoryPhaseView;
  readonly onOpenFile: OpenFile;
  readonly onOpenRunFile: OpenFile;
}) {
  const { view } = props;
  return (
    <View className="gap-4 pb-2">
      <FactorySpine spine={view.spine} />
      <Section title="Role sessions">
        {view.roles.length === 0 ? (
          <Text className="text-xs text-foreground-muted">No role has been dispatched yet.</Text>
        ) : (
          view.roles.map((row) => (
            <FactoryRoleRow key={row.key} row={row} onOpenFile={props.onOpenFile} />
          ))
        )}
      </Section>
      <FactoryPhaseRecord detail={view.detail} onOpenRunFile={props.onOpenRunFile} />
    </View>
  );
});

// Memoized on the section, which the shared model keeps identical while the
// stream leaves its phase unchanged: a live item re-renders only the phases
// it moved.
const FactoryPhaseSection = memo(function FactoryPhaseSection(props: {
  readonly section: FactoryRunSection;
  readonly onToggle: (index: number, open: boolean) => void;
  readonly onOpenFile: OpenFile;
  readonly onOpenRunFile: OpenFile;
}) {
  const { phase, view } = props.section;
  const open = view !== null;
  const tone = FACTORY_MARK_BY_TONE[factoryRailTone(phase.status)];
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Phase ${phase.index}: ${phase.status} — ${phase.title}`}
        accessibilityState={{ expanded: open }}
        className="flex-row items-start gap-2 active:opacity-65"
        onPress={() => props.onToggle(phase.index, !open)}
      >
        <Text className={cn("font-t3-bold text-sm tabular-nums", tone)}>
          {phase.status === "clean" ? `✓${phase.index}` : String(phase.index)}
        </Text>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm text-foreground">{phase.title}</Text>
          <Text className={cn("text-xs", tone)}>{phase.status}</Text>
        </View>
        <Text className="text-sm text-foreground-muted">{open ? "▾" : "▸"}</Text>
      </Pressable>
      {view === null ? null : (
        <FactoryPhaseBody
          view={view}
          onOpenFile={props.onOpenFile}
          onOpenRunFile={props.onOpenRunFile}
        />
      )}
    </View>
  );
});

/**
 * The sections of the latest item, derived when an item arrives or the reader
 * opens or folds a phase. React's pattern for keeping a value from the
 * previous render: compare during render, store in state.
 */
function useFactoryRunSections(
  item: FactoryRunStreamItem | null,
  overrides: FactoryPhaseOverrides,
): FactoryRunSections | null {
  const [derived, setDerived] = useState<{
    item: FactoryRunStreamItem;
    overrides: FactoryPhaseOverrides;
    sections: FactoryRunSections;
  } | null>(null);
  if (item === null) return null;
  if (derived !== null && derived.item === item && derived.overrides === overrides) {
    return derived.sections;
  }
  const sections = deriveFactoryRunSections(item, overrides, derived?.sections ?? null);
  setDerived({ item, overrides, sections });
  return sections;
}

function FactoryRunStream(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly overrides: FactoryPhaseOverrides;
  readonly onToggle: (index: number, open: boolean) => void;
  readonly onOpenFile: OpenFile;
}) {
  const stream = readFactoryRunStreamState(
    useAtomValue(
      factoryEnvironment.factoryRun({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId: props.runId },
      }),
    ),
  );
  const item = stream.status === "ready" ? stream.item : null;
  const sections = useFactoryRunSections(item, props.overrides);
  const repo = item?.state.frame?.repo ?? null;
  const { onOpenFile } = props;
  // A deviation names a path in the run's repository, not in the thread's workspace.
  const onOpenRunFile = useCallback(
    (path: string) => onOpenFile(factoryRunFilePath(repo, path)),
    [onOpenFile, repo],
  );
  if (stream.status === "loading") return <RunMessage text="Loading the run…" />;
  if (stream.status === "failed" || sections === null) {
    return <RunMessage text="The run's state could not be loaded." />;
  }
  return (
    <View className="gap-3">
      <FactoryRunTotals state={stream.item.state} />
      {sections.sections.map((section) => (
        <FactoryPhaseSection
          key={section.phase.index}
          section={section}
          onToggle={props.onToggle}
          onOpenFile={onOpenFile}
          onOpenRunFile={onOpenRunFile}
        />
      ))}
    </View>
  );
}

/**
 * The Factory screen's Run tab: the run's totals, then one collapsible
 * section per phase. The run's stream is subscribed only while the screen is
 * focused, so a phone that leaves the screen stops the server tailing the
 * role files; which phases the reader opened survives the visit.
 */
export function FactoryRunView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: string;
}) {
  const { environmentId, threadId } = props;
  const focused = useIsFocused();
  const navigation = useNavigation();
  const [overrides, setOverrides] = useState<FactoryPhaseOverrides>(() => new Map());
  const onToggle = useCallback((index: number, open: boolean) => {
    setOverrides((current) => new Map(current).set(index, open));
  }, []);
  const onOpenFile = useCallback(
    (path: string) => {
      navigation.navigate("ThreadFile", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        path: fileRoutePathSegments(path),
      });
    },
    [navigation, environmentId, threadId],
  );
  if (!focused) return null;
  return (
    <FactoryRunStream
      environmentId={environmentId}
      threadId={threadId}
      runId={props.runId}
      overrides={overrides}
      onToggle={onToggle}
      onOpenFile={onOpenFile}
    />
  );
}
