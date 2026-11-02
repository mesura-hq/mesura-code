import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import type { ReactNode } from "react";

import { SidebarSeparateSection } from "./SidebarSeparateSection";

/** Mesura: a compact Snoozed entry immediately before the separate Working section. */
export function SidebarSnoozedSection(props: {
  readonly count: number;
  readonly nextWakeAt: string | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly now: string;
  /** The existing shelf decides which rows remain visible while collapsed. */
  readonly children: ReactNode;
}) {
  if (props.count === 0) return null;

  return (
    <li className="list-none">
      <SidebarSeparateSection
        rowId="shelf:snoozed"
        label="Snoozed"
        expanded={props.expanded}
        onToggle={props.onToggle}
        accessory={
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap font-normal tabular-nums">
            <span>{props.count}</span>
            {props.nextWakeAt === null ? null : (
              <span>{snoozeWakeLabel(props.nextWakeAt, { now: props.now })}</span>
            )}
          </span>
        }
      >
        {props.children}
      </SidebarSeparateSection>
    </li>
  );
}
