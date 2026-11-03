import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarSeparateSection(props: {
  readonly rowId: "shelf:snoozed" | "shelf:working";
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly accessory: ReactNode;
  readonly label: string;
  readonly headerWrapperClassName?: string;
  readonly headerAttributes?: Readonly<Record<`data-${string}`, string>>;
  readonly tooltip?: ReactNode;
  readonly children: ReactNode;
}) {
  const header = (
    <CollapsibleSectionHeader
      {...props.headerAttributes}
      expanded={props.expanded}
      onClick={props.onToggle}
      role="treeitem"
      tabIndex={-1}
      // Upstream's tree owns all arrow keys for both separate sections.
      data-sidebar-row={props.rowId}
      data-mesura-nav-stop=""
      accessory={props.accessory}
    >
      {props.label}
    </CollapsibleSectionHeader>
  );

  return (
    <>
      <div data-thread-selection-safe className={cn("mx-0.5 h-8", props.headerWrapperClassName)}>
        {props.tooltip === undefined ? (
          header
        ) : (
          <Tooltip>
            <TooltipTrigger render={header}>{props.label}</TooltipTrigger>
            <TooltipPopup side="right">{props.tooltip}</TooltipPopup>
          </Tooltip>
        )}
      </div>
      <ul role="presentation" className="flex flex-col gap-px">
        {props.children}
      </ul>
    </>
  );
}
