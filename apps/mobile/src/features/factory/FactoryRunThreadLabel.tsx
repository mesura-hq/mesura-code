import type { FactoryRunShellSummary } from "@t3tools/contracts";
import { factoryRunLabel } from "@t3tools/client-runtime/factory/run-presentation";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { FACTORY_TEXT_BY_TONE } from "./factoryTones";

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
      className={cn(
        "shrink-0 text-xs",
        props.selectedClassName ?? FACTORY_TEXT_BY_TONE[label.tone],
      )}
      numberOfLines={1}
    >
      {label.text}
    </Text>
  );
}
