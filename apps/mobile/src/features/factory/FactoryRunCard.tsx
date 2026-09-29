import type { FactoryRunActivityPayload } from "@t3tools/contracts";
import {
  factoryEventClock,
  factoryPhaseMarkTone,
  factoryRunCardModel,
} from "@t3tools/client-runtime/factory/run-presentation";
import { memo, useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { FactoryOpenButton } from "./FactoryOpenButton";
import { FACTORY_MARK_BY_TONE, FACTORY_TEXT_BY_TONE } from "./factoryTones";

/**
 * A Software Factory run attached to this thread, styled like the plan card.
 * The feed replaces its entry in place as events arrive; nothing on it animates.
 */
export const FactoryRunCard = memo(function FactoryRunCard(props: {
  readonly run: FactoryRunActivityPayload;
  /** Opens the thread's Factory screen on this run's Run tab. */
  readonly onOpen: (() => void) | undefined;
}) {
  const card = useMemo(() => factoryRunCardModel(props.run), [props.run]);
  return (
    <View className="my-2 min-w-0 gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="text-xs text-foreground-muted">Factory run</Text>
          <Text className={cn("font-t3-medium text-xs", FACTORY_TEXT_BY_TONE[card.status.tone])}>
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
                FACTORY_MARK_BY_TONE[factoryPhaseMarkTone(mark.status)],
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
          card.lastEventAt === null ? null : `last event ${factoryEventClock(card.lastEventAt)}`,
        ]
          .filter((part) => part !== null)
          .join("  ·  ")}
      </Text>
      {props.onOpen ? (
        <FactoryOpenButton hint="Shows the whole run" onPress={props.onOpen} />
      ) : null}
    </View>
  );
});
