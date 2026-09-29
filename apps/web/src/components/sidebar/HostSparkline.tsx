import type { HostStatsLevel } from "@t3tools/client-runtime/host-stats/levels";
import { memo, useCallback, type PointerEvent } from "react";

import { cn } from "../../lib/utils";
import {
  sparklineAreaPath,
  sparklinePath,
  sparklineSlotAt,
  type SparklineGeometry,
} from "@t3tools/client-runtime/host-stats/view";

/**
 * Colour by level, from theme tokens only: the line is the foreground at 55 %
 * until a level says otherwise, so a healthy fleet reads as monochrome and
 * only trouble has a colour.
 */
export function hostLevelStrokeClass(level: HostStatsLevel | null): string {
  if (level === "crit") return "text-destructive/80";
  if (level === "warn") return "text-warning/80";
  return "text-foreground/55";
}

/**
 * One metric's 12 hours as a hand-drawn line, in the manner of
 * `UsageProviderChart`: a 100-wide viewBox stretched to the column with
 * `preserveAspectRatio="none"`, and `non-scaling-stroke` so the stretch never
 * thickens the line. The path breaks at every missing bucket: a host that was
 * down draws nothing for that time rather than a line across it.
 *
 * Static by design. It redraws when a sample lands, never on a timer, and has
 * no animation of its own.
 */
export const HostSparkline = memo(function HostSparkline(props: {
  readonly series: ReadonlyArray<number | null>;
  /** Each bucket's maximum, drawn as a faint band behind the average. */
  readonly peakSeries: ReadonlyArray<number | null> | null;
  readonly max: number;
  readonly height: number;
  readonly step: boolean;
  readonly level: HostStatsLevel | null;
  readonly hoverSlot: number | null;
  readonly onHoverSlot: (slot: number | null) => void;
  readonly label: string;
}) {
  const { height, hoverSlot, max, onHoverSlot, peakSeries, series, step } = props;
  const geometry: SparklineGeometry = { height, max, step };
  const slotCount = series.length;
  const onPointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (bounds.width <= 0) return;
      onHoverSlot(sparklineSlotAt((event.clientX - bounds.left) / bounds.width, slotCount));
    },
    [onHoverSlot, slotCount],
  );
  const onPointerLeave = useCallback(() => onHoverSlot(null), [onHoverSlot]);
  const hoverX = hoverSlot === null ? null : (hoverSlot / Math.max(1, slotCount - 1)) * 100;
  return (
    <svg
      aria-label={props.label}
      className={cn("block w-full overflow-visible", hostLevelStrokeClass(props.level))}
      data-host-sparkline
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      preserveAspectRatio="none"
      role="img"
      style={{ height }}
      viewBox={`0 0 100 ${height}`}
    >
      {peakSeries === null ? null : (
        <path
          d={sparklineAreaPath(peakSeries, geometry)}
          data-sparkline-peak
          fill="currentColor"
          fillOpacity={0.07}
        />
      )}
      <path d={sparklineAreaPath(series, geometry)} fill="currentColor" fillOpacity={0.09} />
      <path
        d={sparklinePath(series, geometry)}
        data-sparkline-line
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      />
      {hoverX === null ? null : (
        <line
          className="text-foreground/50"
          stroke="currentColor"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          x1={hoverX}
          x2={hoverX}
          y1={0}
          y2={height}
        />
      )}
    </svg>
  );
});
