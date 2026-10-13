import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ServerIcon } from "lucide-react";
import { useState } from "react";

import { useIsMobile } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { WorkloadList } from "./WorkloadList";

export function ThreadWorkloadsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const isMobile = useIsMobile();
  // Delimiter joins collide for valid IDs with colons. Compare each owner field
  // so a new environment or thread always closes the previous owner's surface.
  const owner = { environmentId: props.environmentId, threadId: props.threadId, isMobile };
  const [surface, setSurface] = useState({ ...owner, open: false });
  const sameOwner =
    surface.environmentId === owner.environmentId &&
    surface.threadId === owner.threadId &&
    surface.isMobile === owner.isMobile;
  if (!sameOwner) setSurface({ ...owner, open: false });
  const open = sameOwner && surface.open;
  const setOpen = (next: boolean) => setSurface({ ...owner, open: next });
  const trigger = (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label="Servers in this thread"
      aria-expanded={open}
      data-thread-workloads-trigger
    >
      <ServerIcon />
    </Button>
  );
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Servers in this thread"
          aria-expanded={open}
          data-thread-workloads-trigger
          onClick={() => setOpen(true)}
        >
          <ServerIcon />
        </Button>
        <SheetPopup side="bottom" className="max-h-[85dvh]">
          <SheetHeader>
            <SheetTitle>Servers in this thread</SheetTitle>
            <SheetDescription>Workloads registered by this thread on its host.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-6 pb-6">
            <WorkloadList {...props} visible={open} />
          </div>
        </SheetPopup>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup width="lg" padding="compact" align="end">
        <div className="mb-2 flex items-center justify-between gap-2">
          <PopoverTitle>Servers in this thread</PopoverTitle>
          <PopoverClose render={<Button size="compact" variant="ghost" />}>Close</PopoverClose>
        </div>
        <WorkloadList {...props} visible={open} />
      </PopoverPopup>
    </Popover>
  );
}
