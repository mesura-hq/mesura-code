import type { FactoryRunShellSummary } from "@t3tools/contracts";
import {
  factoryRunLabel,
  type FactoryRunTone,
} from "@t3tools/client-runtime/factory/run-presentation";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

// Status hues shared with the web sidebar's label: sky running, amber
// waiting or stopped, emerald done, rose degraded.
const CLASS_BY_TONE: Record<FactoryRunTone, string> = {
  info: "text-adaptive-sky-600-400",
  warning: "text-adaptive-amber-700-300",
  success: "text-adaptive-emerald-700-300",
  error: "text-adaptive-rose-700-300",
};

/**
 * A thread list row's Software Factory label, such as `phase 5/11 · Review`;
 * nothing for a thread without a run. On a selected row it takes the row's
 * selected foreground, like the rest of the row's text.
 */
export function FactoryRunThreadLabel(props: {
  readonly run: FactoryRunShellSummary | null | undefined;
  readonly selectedClassName: string | null;
}) {
  const label = factoryRunLabel(props.run);
  if (label === null) return null;
  return (
    <Text
      className={cn("shrink-0 text-xs", props.selectedClassName ?? CLASS_BY_TONE[label.tone])}
      numberOfLines={1}
    >
      {label.text}
    </Text>
  );
}
