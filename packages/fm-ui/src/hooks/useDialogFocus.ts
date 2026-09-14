import { type RefObject, useEffect } from "react";
/** Restore the triggering control after the dialog releases focus. */
export function useDialogFocus(panel: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const origin = document.activeElement;
    panel.current?.focus();
    return () => {
      if (origin instanceof HTMLElement) origin.focus();
    };
  }, [panel]);
}
