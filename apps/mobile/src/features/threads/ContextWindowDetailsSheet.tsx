import {
  CONTEXT_WINDOW_COLD_CACHE_MESSAGE,
  type ContextWindowSegmentKind,
  type ContextWindowSnapshot,
  deriveContextWindowCacheSplit,
  deriveContextWindowRequestBreakdown,
  deriveContextWindowRequestSegments,
  deriveContextWindowSegments,
  formatContextWindowCachedPercentage,
  formatContextWindowTokens,
  formatContextWindowUsedPercentage,
  isContextWindowCacheCold,
} from "@t3tools/client-runtime/context-window";
import type { ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { ContextWindowSegmentDot, ContextWindowSegmentedBar } from "./ContextWindowIndicator";

function BreakdownRow(props: {
  readonly label: string;
  readonly dotKind?: ContextWindowSegmentKind;
  readonly children: ReactNode;
}) {
  return (
    <View className="flex-row items-baseline justify-between gap-3">
      <View className="flex-row items-center gap-1.5">
        {props.dotKind ? <ContextWindowSegmentDot kind={props.dotKind} /> : null}
        <Text className="text-sm text-foreground-secondary">{props.label}</Text>
      </View>
      <Text className="text-sm font-t3-medium tabular-nums text-foreground-secondary">
        {props.children}
      </Text>
    </View>
  );
}

/** Input, output and prompt-cache split of the latest request. Nothing without input. */
function ContextWindowRequestDetails(props: { readonly snapshot: ContextWindowSnapshot }) {
  const breakdown = deriveContextWindowRequestBreakdown(props.snapshot);
  if (!breakdown) {
    return null;
  }
  const requestSegments = deriveContextWindowRequestSegments(props.snapshot);
  const cacheSplit = deriveContextWindowCacheSplit(breakdown);
  const isCacheCold = isContextWindowCacheCold(breakdown);
  return (
    <View className="gap-2 border-t border-border-subtle pt-3">
      <Text className="text-sm font-t3-medium text-foreground-muted">Last request</Text>
      {requestSegments.length > 1 ? (
        <ContextWindowSegmentedBar segments={requestSegments} scale="request" height={8} />
      ) : null}
      <BreakdownRow label="Input" {...(cacheSplit.length === 0 ? { dotKind: "input" } : {})}>
        {formatContextWindowTokens(breakdown.inputTokens)}
        {breakdown.cachedPercentage !== null ? (
          <>
            {" · "}
            <Text className={cn(isCacheCold && "text-warning-foreground")}>
              {formatContextWindowCachedPercentage(breakdown.cachedPercentage)} cached
            </Text>
          </>
        ) : null}
      </BreakdownRow>
      {cacheSplit.length > 0 ? (
        <View className="flex-row flex-wrap justify-end gap-x-3 gap-y-1">
          {cacheSplit.map((part) => (
            <View key={part.kind} className="flex-row items-center gap-1">
              <ContextWindowSegmentDot kind={part.kind} />
              <Text className="text-xs tabular-nums text-foreground-muted">{part.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {breakdown.outputTokens !== null ? (
        <BreakdownRow label="Output" dotKind="output">
          {formatContextWindowTokens(breakdown.outputTokens)}
          {breakdown.reasoningTokens !== null && breakdown.reasoningTokens > 0
            ? ` · thinking ${formatContextWindowTokens(breakdown.reasoningTokens)}`
            : null}
        </BreakdownRow>
      ) : null}
      {isCacheCold ? (
        <Text className="text-sm text-warning-foreground">{CONTEXT_WINDOW_COLD_CACHE_MESSAGE}</Text>
      ) : null}
    </View>
  );
}

/**
 * The context-window details the web shows in its popover: the used share,
 * the window bar, the last request and a compact action. `onCompact` is
 * omitted when the provider cannot compact natively.
 */
export function ContextWindowDetailsSheet(props: {
  readonly snapshot: ContextWindowSnapshot;
  readonly onClose: () => void;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { snapshot } = props;
  const usedPercentage = formatContextWindowUsedPercentage(snapshot.usedPercentage);
  const windowSegments = deriveContextWindowSegments(snapshot);
  return (
    <Modal
      animationType="slide"
      presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
      transparent={Platform.OS === "android"}
      onRequestClose={props.onClose}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          backgroundColor: Platform.OS === "android" ? "#00000066" : undefined,
        }}
      >
        {Platform.OS === "android" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss context window details"
            onPress={props.onClose}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
        ) : null}
        <View
          className="overflow-hidden rounded-t-3xl bg-sheet-solid"
          style={Platform.OS === "android" ? undefined : { flex: 1 }}
        >
          <View className="flex-row items-center justify-between gap-3 border-b border-border px-4 pb-2 pt-4">
            <Text className="min-w-0 flex-1 text-base font-t3-semibold text-foreground">
              Context window
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close context window details"
              onPress={props.onClose}
              className="p-3"
            >
              <Text className="text-foreground">Done</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{
              padding: 16,
              gap: 12,
              paddingBottom: Math.max(20, insets.bottom),
            }}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <Text className="text-2xl font-t3-semibold tabular-nums text-foreground">
                {snapshot.maxTokens !== null && usedPercentage
                  ? `${usedPercentage} used`
                  : `${formatContextWindowTokens(snapshot.usedTokens)} used`}
              </Text>
              {snapshot.maxTokens !== null ? (
                <Text className="text-sm tabular-nums text-foreground-muted">
                  {formatContextWindowTokens(snapshot.usedTokens)}/
                  {formatContextWindowTokens(snapshot.maxTokens ?? null)}
                </Text>
              ) : null}
            </View>
            {windowSegments.length > 0 ? (
              <ContextWindowSegmentedBar segments={windowSegments} scale="window" height={6} />
            ) : null}
            <ContextWindowRequestDetails snapshot={snapshot} />
            {props.onCompact ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: props.compactDisabled }}
                disabled={props.compactDisabled}
                onPress={props.onCompact}
                className={cn(
                  "mt-1 min-h-11 flex-row items-center justify-center gap-2 rounded-xl border border-border px-4 active:bg-subtle",
                  props.compactDisabled && "opacity-50",
                )}
              >
                <SymbolView
                  name="arrow.down.right.and.arrow.up.left"
                  size={14}
                  tintColorClassName="accent-foreground"
                  type="monochrome"
                />
                <Text className="text-sm font-t3-medium text-foreground">Compact context</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
