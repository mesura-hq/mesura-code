import {
  CONTEXT_WINDOW_RING_CIRCUMFERENCE,
  CONTEXT_WINDOW_RING_RADIUS,
  type ContextWindowSegment,
  type ContextWindowSegmentKind,
  type ContextWindowSnapshot,
  deriveContextWindowPressureColor,
  deriveContextWindowRingArcs,
  deriveContextWindowSegments,
  formatContextWindowAccessibilityLabel,
  formatContextWindowIndicatorLabels,
} from "@t3tools/client-runtime/context-window";
import { Pressable, View } from "react-native";
import Svg, { Circle, G } from "react-native-svg";
import { withUniwind } from "uniwind";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { layoutContextWindowBarParts } from "./contextWindowIndicatorState";

const ThemedSvg = withUniwind(Svg);

/**
 * The web's sky-500, amber-500 and violet-500, legible on light and dark
 * surfaces. `null` kinds take the theme's muted foreground, as on the web.
 */
const CONTEXT_WINDOW_SEGMENT_COLORS: Readonly<Record<ContextWindowSegmentKind, string | null>> = {
  cacheRead: null,
  cacheWrite: "#0ea5e9",
  uncached: "#f59e0b",
  input: null,
  output: "#8b5cf6",
};
/** The web mixes the muted foreground at 72% for segments and 24% for the track. */
const MUTED_SEGMENT_OPACITY = 0.72;
const TRACK_OPACITY = 0.24;
const MUTED_SEGMENT_CLASS_NAME = "bg-foreground-muted/70";
const TRACK_CLASS_NAME = "bg-foreground-muted/25";

/** A bar or dot fill for one segment kind: a fixed colour, or the themed muted class. */
function segmentFill(kind: ContextWindowSegmentKind) {
  const color = CONTEXT_WINDOW_SEGMENT_COLORS[kind];
  return color === null
    ? { className: MUTED_SEGMENT_CLASS_NAME, style: undefined }
    : { className: undefined, style: { backgroundColor: color } };
}

/**
 * One arc per segment, clockwise from the top, with the web ring's geometry.
 * `currentColor` resolves to the theme's muted foreground through Uniwind.
 * From half full, one arc of the used share in the pressure colour replaces
 * the segments, as on the web.
 */
export function ContextWindowSegmentedRing(props: {
  readonly segments: ReadonlyArray<ContextWindowSegment>;
  readonly usedPercentage: number | null;
  readonly size: number;
}) {
  const pressureColor = deriveContextWindowPressureColor(props.usedPercentage);
  const arcs = pressureColor === null ? deriveContextWindowRingArcs(props.segments) : [];
  const pressureLength =
    (Math.min(100, props.usedPercentage ?? 0) / 100) * CONTEXT_WINDOW_RING_CIRCUMFERENCE;
  return (
    <ThemedSvg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      colorClassName="accent-foreground-muted"
    >
      <G transform="rotate(-90 12 12)">
        <Circle
          cx={12}
          cy={12}
          r={CONTEXT_WINDOW_RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity={TRACK_OPACITY}
          strokeWidth={3}
        />
        {arcs.map((arc) => {
          const color = CONTEXT_WINDOW_SEGMENT_COLORS[arc.kind];
          return (
            <Circle
              key={arc.kind}
              cx={12}
              cy={12}
              r={CONTEXT_WINDOW_RING_RADIUS}
              fill="none"
              stroke={color ?? "currentColor"}
              strokeOpacity={color === null ? MUTED_SEGMENT_OPACITY : 1}
              strokeWidth={3}
              strokeDasharray={[arc.visibleLength, CONTEXT_WINDOW_RING_CIRCUMFERENCE]}
              strokeDashoffset={-arc.start}
            />
          );
        })}
        {pressureColor === null ? null : (
          <Circle
            cx={12}
            cy={12}
            r={CONTEXT_WINDOW_RING_RADIUS}
            fill="none"
            stroke={pressureColor}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={[pressureLength, CONTEXT_WINDOW_RING_CIRCUMFERENCE]}
          />
        )}
      </G>
    </ThemedSvg>
  );
}

/**
 * A horizontal bar of the same segments. `window` keeps each segment's share
 * of the whole window; `request` stretches them to full width.
 */
export function ContextWindowSegmentedBar(props: {
  readonly segments: ReadonlyArray<ContextWindowSegment>;
  readonly scale: "window" | "request";
  readonly height: number;
}) {
  const parts = layoutContextWindowBarParts(props.segments, props.scale);
  if (parts.length === 0) {
    return null;
  }
  return (
    <View
      className={cn("w-full flex-row overflow-hidden rounded-full", TRACK_CLASS_NAME)}
      style={{ height: props.height, gap: 1 }}
    >
      {parts.map((part) => {
        const fill = part.kind === null ? null : segmentFill(part.kind);
        return (
          <View
            key={part.key}
            className={fill?.className}
            style={[{ flexGrow: part.grow, flexBasis: 0 }, fill?.style]}
          />
        );
      })}
    </View>
  );
}

export function ContextWindowSegmentDot(props: { readonly kind: ContextWindowSegmentKind }) {
  const fill = segmentFill(props.kind);
  return <View className={cn("size-1.5 rounded-full", fill.className)} style={fill.style} />;
}

/**
 * The composer's context-window control: `pill` reads `65k ◯ 1M` in the
 * expanded toolbar, `ring` is the ring alone for the collapsed row. Both are a
 * 44-point button that opens the details sheet.
 */
export function ContextWindowIndicator(props: {
  readonly snapshot: ContextWindowSnapshot;
  readonly variant: "pill" | "ring";
  readonly onPress: () => void;
}) {
  const { snapshot } = props;
  const segments = deriveContextWindowSegments(snapshot);
  const labels = formatContextWindowIndicatorLabels(snapshot);
  return (
    <Pressable
      accessibilityLabel={formatContextWindowAccessibilityLabel(snapshot)}
      accessibilityRole="button"
      className={cn(
        // Explicit points: `min-w-11` is 38.5pt under the app's 14px rem, and
        // `hitSlop` loses to the 44pt dictation button beside the ring.
        "min-h-[44px] min-w-[44px] shrink-0 flex-row items-center justify-center gap-1 active:opacity-70",
        props.variant === "pill" && "px-1.5",
      )}
      onPress={props.onPress}
    >
      {props.variant === "pill" ? (
        <Text className="text-xs font-t3-medium tabular-nums text-foreground-muted">
          {labels.used}
        </Text>
      ) : null}
      <ContextWindowSegmentedRing
        segments={segments}
        usedPercentage={snapshot.usedPercentage}
        size={props.variant === "pill" ? 16 : 20}
      />
      {props.variant === "pill" && labels.max !== null ? (
        <Text className="text-xs tabular-nums text-foreground-muted">{labels.max}</Text>
      ) : null}
    </Pressable>
  );
}
