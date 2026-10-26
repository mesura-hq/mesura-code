import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import type { usePaneEdge } from "~/lib/paneEdges";
import { cn } from "~/lib/utils";

interface Props {
  handlers: ResizableWidthHandlers;
  /** Fork: focus and arrow keys for the handle (lib/paneEdges.ts). */
  separatorProps?: ReturnType<typeof usePaneEdge>;
  className?: string;
}

export function RightPanelResizeHandle({ handlers, separatorProps, className }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      className={cn(
        "group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none outline-none",
        className,
      )}
      {...separatorProps}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
      />
    </div>
  );
}
