import type { FactoryRunActivityPayload } from "@t3tools/contracts";
import {
  factoryPhaseMarkTone,
  factoryRunCardModel,
  type FactoryPhaseMarkTone,
  type FactoryRunTone,
} from "@t3tools/client-runtime/factory/run-presentation";
import { memo, useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

// The same hue family as the thread list row's run label.
const TEXT_BY_TONE: Record<FactoryRunTone, string> = {
  info: "text-adaptive-sky-600-400",
  warning: "text-adaptive-amber-700-300",
  success: "text-adaptive-emerald-700-300",
  error: "text-adaptive-rose-700-300",
};
const MARK_BY_TONE: Record<FactoryPhaseMarkTone, string> = {
  ...TEXT_BY_TONE,
  neutral: "text-foreground-tertiary",
};

function eventClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A Software Factory run attached to this thread, styled like the plan card.
 * The feed replaces its entry in place as events arrive; nothing on it animates.
 */
export const FactoryRunCard = memo(function FactoryRunCard(props: {
  readonly run: FactoryRunActivityPayload;
}) {
  const card = useMemo(() => factoryRunCardModel(props.run), [props.run]);
  return (
    <View className="my-2 min-w-0 gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="text-xs text-foreground-muted">Factory run</Text>
          <Text className={cn("font-t3-medium text-xs", TEXT_BY_TONE[card.status.tone])}>
            {card.status.text}
          </Text>
        </View>
        <Text className="font-t3-bold text-base text-foreground">
          {card.request ?? props.run.runId}
        </Text>
      </View>
      {card.phase === null ? null : (
        <Text className="text-sm text-foreground" numberOfLines={2}>
          {`Phase ${card.phase.index}/${card.phase.count}: ${card.phase.title}`}
          {card.node === null ? null : ` · ${card.node}`}
        </Text>
      )}
      {card.question === null ? null : (
        <View className="rounded-lg border border-border bg-subtle px-3 py-2">
          <Text className="text-sm text-foreground">{card.question}</Text>
        </View>
      )}
      {card.marks.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-1.5">
          {card.marks.map((mark) => (
            <Text
              key={mark.index}
              accessibilityLabel={`Phase ${mark.index}: ${mark.status}`}
              className={cn(
                "font-t3-medium text-xs tabular-nums",
                MARK_BY_TONE[factoryPhaseMarkTone(mark.status)],
              )}
            >
              {mark.status === "clean" ? `✓${mark.index}` : String(mark.index)}
            </Text>
          ))}
        </View>
      )}
      <Text className="text-xs text-foreground-muted tabular-nums">
        {[
          card.returns,
          card.cost,
          card.lastEventAt === null ? null : `last event ${eventClock(card.lastEventAt)}`,
        ]
          .filter((part) => part !== null)
          .join("  ·  ")}
      </Text>
    </View>
  );
});
