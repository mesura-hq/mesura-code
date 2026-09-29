import type { HostStatsHostView, HostStatsRow } from "@t3tools/client-runtime/host-stats";
import type { HostStatsLevel } from "@t3tools/client-runtime/host-stats/levels";
import {
  HOSTS_DOCK_ROW_IDS,
  HOSTS_DOCK_ROW_VISUAL,
  formatUptime,
  hostIsDimmed,
  hostRowDisplay,
  hostServersLine,
  hostShowsUptime,
  hostStatusLine,
  sparklineMax,
  type HostsDockRowId,
} from "@t3tools/client-runtime/host-stats/view";
import { memo } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { HostSparkline } from "./HostSparkline";
import { hostRowAccessibilityLabel } from "./hostsScreen.logic";

const SPARKLINE_HEIGHT = 22;
const STEP_SPARKLINE_HEIGHT = 18;

function levelTextClass(level: HostStatsLevel | null): string | undefined {
  if (level === "crit") return "text-danger-foreground";
  if (level === "warn") return "text-warning-foreground";
  return undefined;
}

function levelBarClass(level: HostStatsLevel | null): string {
  if (level === "crit") return "bg-danger";
  if (level === "warn") return "bg-warning";
  return "bg-foreground-muted";
}

/**
 * One metric line, the web dock's "Rows" layout at phone width: label, the
 * 12-hour history or a bar, and the value with its muted suffix. The value
 * takes the width it needs and the history shrinks, since the web dock's fixed
 * value column cut "vram 13%" and network rates at phone width. The row is
 * one accessible element whose label names its level, which is otherwise only
 * a colour.
 */
const HostRow = memo(function HostRow(props: {
  readonly rowId: HostsDockRowId;
  readonly row: HostStatsRow;
}) {
  const { row, rowId } = props;
  const display = hostRowDisplay(rowId, row);
  const visual = HOSTS_DOCK_ROW_VISUAL[rowId];
  return (
    <View
      accessible
      accessibilityLabel={hostRowAccessibilityLabel(display, row)}
      className="flex-row items-center gap-3"
      testID={`host-row:${rowId}`}
    >
      <Text className="w-14 font-mono text-xs text-foreground-muted" numberOfLines={1}>
        {display.label}
      </Text>
      {/* The history gives way before the value: a value is never cut. */}
      <View className="min-w-0 flex-1">
        {visual === "bar" ? (
          <View className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle">
            <View
              className={cn("h-full rounded-full", levelBarClass(row.level))}
              style={{ flex: Math.min(100, Math.max(0, row.value ?? 0)) }}
            />
            <View style={{ flex: 100 - Math.min(100, Math.max(0, row.value ?? 0)) }} />
          </View>
        ) : row.series === null ? null : (
          <HostSparkline
            height={visual === "step" ? STEP_SPARKLINE_HEIGHT : SPARKLINE_HEIGHT}
            label={`${display.label}, last 12 hours`}
            level={row.level}
            max={sparklineMax(rowId, row.series)}
            peakSeries={row.peakSeries}
            series={row.series}
            step={visual === "step"}
          />
        )}
      </View>
      <Text
        className={cn(
          "min-w-24 shrink-0 text-right text-sm font-t3-medium tabular-nums text-foreground",
          levelTextClass(row.level),
        )}
      >
        {display.value}
        {display.suffix ? (
          <Text
            className={cn(
              "font-mono text-xs text-foreground-muted",
              levelTextClass(row.secondaryLevel),
            )}
          >
            {` ${display.suffix}`}
          </Text>
        ) : null}
      </Text>
    </View>
  );
});

/**
 * One host as a card: its name, platform and uptime, the line that says why
 * its numbers are not current, then one row per metric and the servers line.
 * Stale and offline hosts keep their last numbers, dimmed, under that line.
 */
export const HostSection = memo(function HostSection(props: { readonly host: HostStatsHostView }) {
  const { host } = props;
  const status = hostStatusLine(host);
  const showsUptime = hostShowsUptime(host);
  const servers = host.rows === null ? null : hostServersLine(host.rows.servers);
  return (
    <View
      className="gap-3 rounded-[24px] border-continuous bg-card p-4"
      testID={`host:${host.environmentId}`}
    >
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <SymbolView
            name="server.rack"
            size={16}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
          <Text className="shrink text-base font-t3-medium text-foreground" numberOfLines={1}>
            {host.label}
          </Text>
          {host.isPrimary ? (
            <View className="rounded-md border border-border px-1.5">
              <Text className="font-mono text-[11px] text-foreground-muted">local</Text>
            </View>
          ) : host.platform ? (
            <Text className="font-mono text-xs text-foreground-tertiary">{host.platform}</Text>
          ) : null}
          {showsUptime ? (
            <Text className="ml-auto font-mono text-xs text-foreground-tertiary">
              {formatUptime(host.uptimeMs!)}
            </Text>
          ) : null}
        </View>
        {status ? <Text className="text-sm text-foreground-muted">{status.text}</Text> : null}
      </View>
      {host.rows === null ? null : (
        <View className={cn("gap-2.5", hostIsDimmed(host) && "opacity-55")}>
          {HOSTS_DOCK_ROW_IDS.map((rowId) => (
            <HostRow key={rowId} row={host.rows![rowId]} rowId={rowId} />
          ))}
          {servers ? (
            <View className="flex-row items-center gap-1.5">
              <SymbolView
                name="server.rack"
                size={13}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
              <Text className="text-xs text-foreground-muted">{servers.text}</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
});
