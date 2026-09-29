import type { HostStatsLevel } from "@t3tools/client-runtime/host-stats/levels";
import {
  sparklineAreaPath,
  sparklinePath,
  type SparklineGeometry,
} from "@t3tools/client-runtime/host-stats/view";
import { memo } from "react";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** Colour by level, from theme tokens only: a healthy fleet reads as monochrome. */
function levelColorClassName(level: HostStatsLevel | null): string {
  if (level === "crit") return "accent-danger-foreground";
  if (level === "warn") return "accent-warning-foreground";
  return "accent-foreground-muted";
}

/**
 * One metric's 12 hours, drawn like the web dock's sparkline: a 100-wide
 * viewBox stretched to the row with `preserveAspectRatio="none"` and a
 * non-scaling stroke. The path breaks at every missing bucket, so a host that
 * was down draws nothing for that time rather than a line across it.
 *
 * Static by design: it redraws when a sample lands, never on a timer.
 */
export const HostSparkline = memo(function HostSparkline(props: {
  readonly series: ReadonlyArray<number | null>;
  /** Each bucket's maximum, drawn as a faint band behind the average. */
  readonly peakSeries: ReadonlyArray<number | null> | null;
  readonly max: number;
  readonly height: number;
  readonly step: boolean;
  readonly level: HostStatsLevel | null;
  readonly label: string;
}) {
  const { height, max, peakSeries, series, step } = props;
  const geometry: SparklineGeometry = { height, max, step };
  const colorClassName = levelColorClassName(props.level);
  return (
    <Svg
      accessibilityLabel={props.label}
      height={height}
      preserveAspectRatio="none"
      viewBox={`0 0 100 ${height}`}
      width="100%"
    >
      {peakSeries === null ? null : (
        <ThemedPath
          colorClassName={colorClassName}
          d={sparklineAreaPath(peakSeries, geometry)}
          fill="currentColor"
          fillOpacity={0.07}
        />
      )}
      <ThemedPath
        colorClassName={colorClassName}
        d={sparklineAreaPath(series, geometry)}
        fill="currentColor"
        fillOpacity={0.09}
      />
      <ThemedPath
        colorClassName={colorClassName}
        d={sparklinePath(series, geometry)}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
});
