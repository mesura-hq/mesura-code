import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/**
 * A strip chip that shows part of the run context and opens the drawer at its
 * tab. It keeps the old selectors' look and their label markup, so the strip
 * still compacts labels to icons when space runs out.
 */
export function RunContextStripTrigger(props: {
  icon: ReactNode;
  label: string;
  /** Read-only tabs still open the drawer, so the branch stays reachable. */
  locked: boolean;
  drawerOpen: boolean;
  onPress: () => void;
  ariaLabel: string;
  /** Space-separated composer.* commands whose openControl lands here. */
  composerShortcut?: string;
  layout: "paired" | "host" | "workspace";
}) {
  const { icon, label, locked, drawerOpen, onPress, ariaLabel, composerShortcut, layout } = props;
  return (
    <Button
      variant="ghost-subtle"
      size="xs"
      aria-label={ariaLabel}
      aria-expanded={drawerOpen}
      data-composer-shortcut={composerShortcut}
      data-composer-context-control
      data-readonly={locked || undefined}
      data-open={drawerOpen || undefined}
      className={cn(
        "min-w-0 active:scale-100",
        layout === "paired" && "max-w-[48%] flex-initial justify-start",
        layout === "host" && "max-w-full",
        layout === "workspace" && "shrink",
      )}
      onClick={onPress}
    >
      {icon}
      <span
        data-composer-label
        className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
      >
        <span
          data-composer-label-motion
          className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
        >
          {label}
        </span>
      </span>
      {locked ? null : (
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 opacity-50 transition-transform duration-150",
            drawerOpen && "rotate-180",
          )}
        />
      )}
    </Button>
  );
}
