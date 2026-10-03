import type { ReactElement } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** The app's tooltip around one control; the repo forbids native `title` tooltips. */
export function Hint(props: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
