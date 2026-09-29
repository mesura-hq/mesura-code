import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

/** The mark beside a dollar figure that leaves out the Codex turns, which report only tokens. */
export function FactoryCostFloor() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="ml-1 rounded-sm border border-warning/40 px-1 text-warning-foreground" />
        }
      >
        floor
      </TooltipTrigger>
      <TooltipPopup side="top">
        Codex turns report tokens, not dollars, so the dollar figure is a lower bound.
      </TooltipPopup>
    </Tooltip>
  );
}
