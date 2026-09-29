import type {
  EnvironmentId,
  FactoryReportActivityPayload,
  FactoryRunActivityPayload,
} from "@t3tools/contracts";
import { deriveFactoryReportCard } from "@t3tools/client-runtime/factory/report-view";
import { splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import { memo, useMemo, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { FactoryOpenButton } from "./FactoryOpenButton";
import { FACTORY_TEXT_BY_TONE } from "./factoryTones";
import { useFactorySnapshot } from "./useFactorySnapshot";

/**
 * The report a Software Factory run wrote, styled like the plan card. Its
 * prose (Context, What was built) is `report.md` read by digest; its numbers
 * come from the run's `factory.run` payload, never the run stream.
 */
export const FactoryReportCard = memo(function FactoryReportCard(props: {
  readonly report: FactoryReportActivityPayload;
  readonly run: FactoryRunActivityPayload | null;
  readonly environmentId: EnvironmentId;
  /** Opens the thread's Factory screen on this run's Report tab. */
  readonly onOpen: (() => void) | undefined;
  readonly renderMarkdown: (markdown: string) => ReactNode;
}) {
  const snapshot = useFactorySnapshot(props.environmentId, props.report.digest);
  const markdown = snapshot.status === "ready" ? snapshot.markdown : null;
  const card = useMemo(
    () =>
      deriveFactoryReportCard({
        report: splitFactoryDocument(markdown ?? `# ${props.report.title}\n`),
        summary: props.run,
      }),
    [markdown, props.report.title, props.run],
  );
  return (
    <View className="my-2 min-w-0 gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="gap-0.5">
        <Text className="text-xs text-foreground-muted">Factory report</Text>
        <Text className="font-t3-bold text-base text-foreground">
          {card.title || props.report.title}
        </Text>
      </View>
      {snapshot.status === "loading" ? (
        <View accessibilityLabel="Loading the report" className="gap-2 py-1">
          <View className="h-3 w-full rounded-full bg-subtle" />
          <View className="h-3 w-2/3 rounded-full bg-subtle" />
        </View>
      ) : snapshot.status === "failed" ? (
        <Text className="text-xs text-foreground-muted">
          The report's text could not be loaded.
        </Text>
      ) : (
        <>
          {card.context === null || card.context === "" ? null : props.renderMarkdown(card.context)}
          {card.built === null || card.built.bullets.length === 0
            ? null
            : props.renderMarkdown(card.built.bullets.map((bullet) => `- ${bullet}`).join("\n"))}
        </>
      )}
      {card.coverage === null && card.degraded === null ? null : (
        <View className="flex-row flex-wrap gap-x-3">
          {card.coverage === null ? null : (
            <Text className="text-xs text-foreground-muted tabular-nums">{card.coverage}</Text>
          )}
          {card.degraded === null ? null : (
            <Text
              className={cn(
                "text-xs tabular-nums",
                card.hasDegraded ? FACTORY_TEXT_BY_TONE.error : "text-foreground-muted",
              )}
            >
              {card.degraded}
            </Text>
          )}
        </View>
      )}
      {props.onOpen ? (
        <FactoryOpenButton hint="Shows the whole report" onPress={props.onOpen} />
      ) : null}
    </View>
  );
});
