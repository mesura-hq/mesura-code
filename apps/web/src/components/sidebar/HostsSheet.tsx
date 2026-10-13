import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useIsMobile } from "../../hooks/useMediaQuery";
import { closeHostsSheet, hostsSheetOpenAtom } from "../../state/hostsSurface";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { HostsLiveContent } from "./HostsPanel";

/** Mounted beside the palette, outside the mobile sidebar's disposable portal. */
export function HostsSheet() {
  const requested = useAtomValue(hostsSheetOpenAtom);
  const isMobile = useIsMobile();
  const pathname = useLocation({ select: (location) => location.pathname });
  const previousPathname = useRef(pathname);
  useEffect(() => {
    if (previousPathname.current !== pathname) closeHostsSheet();
    previousPathname.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (!isMobile && requested) closeHostsSheet();
  }, [isMobile, requested]);
  useEffect(
    () => () => {
      closeHostsSheet();
    },
    [],
  );
  const open = isMobile && requested;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) closeHostsSheet();
      }}
    >
      <SheetPopup
        side="bottom"
        className="max-h-[85dvh]"
        finalFocus={() =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="sidebar-trigger"]')).find(
            (trigger) => !trigger.closest('[data-mobile="true"]'),
          ) ?? true
        }
      >
        <SheetHeader>
          <SheetTitle>Hosts</SheetTitle>
          <SheetDescription>
            Host readings and registered workloads for each environment.
          </SheetDescription>
        </SheetHeader>
        {open ? <HostsLiveContent open shortcutLabel={null} sheet /> : null}
      </SheetPopup>
    </Sheet>
  );
}
