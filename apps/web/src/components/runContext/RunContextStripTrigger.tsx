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
  className?: string;
}) {
  const { icon, label, locked, drawerOpen, onPress, ariaLabel, composerShortcut, className } =
    props;
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={ariaLabel}
      aria-expanded={drawerOpen}
      data-composer-shortcut={composerShortcut}
      data-composer-context-control
      className={cn(
        "min-w-0 font-normal text-xs! active:scale-100",
        locked ? "text-muted-foreground/70" : "text-muted-foreground/70 hover:text-foreground/80",
        drawerOpen && "text-foreground/85",
        className,
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
          className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
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
