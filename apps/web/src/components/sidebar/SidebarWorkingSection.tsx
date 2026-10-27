import { useAtomValue } from "@effect/atom-react";
import { type KeyboardEvent, type ReactNode, useRef } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { setWorkingSectionExpanded } from "./workingSection";
import { useSeenOnScreen, useWorkingSweep } from "./workingSweep";

/**
 * Mesura: the Working section under Search (`workingSection.ts`). Its header shows at every count,
 * so the list below never shifts when the first thread starts or the last one stops.
 */
export function SidebarWorkingSection(props: {
  readonly count: number;
  readonly expanded: boolean;
  /** The rows to show: every working thread, or only the open thread's while collapsed. */
  readonly children: ReactNode;
}) {
  const { count, expanded } = props;
  const sectionRef = useRef<HTMLDivElement>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const redesign = useClientSettings((settings) => settings.redesignEnabled);
  const seen = useSeenOnScreen(sectionRef);
  useWorkingSweep(sectionRef, expanded && seen && count > 0);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggleWorking");
  const action = expanded ? "Collapse working threads" : "Show working threads";

  const onHeaderKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setWorkingSectionExpanded(event.key === "ArrowRight");
  };

  return (
    <div ref={sectionRef} data-working-section="" data-testid="sidebar-working-section">
      {/* Sticky inside its own block on desktop: it rides the top while working rows scroll under
          it, then leaves with them. The phone drawer's surface sits outside `[data-app-sidebar]`,
          whose `--sidebar` differs, so a sticky background there shows as a dark bar. */}
      <div
        data-thread-selection-safe
        className="mx-0.5 h-8 md:sticky md:top-0 md:z-20 md:bg-sidebar md:surface-grain"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <CollapsibleSectionHeader
                expanded={expanded}
                onClick={() => setWorkingSectionExpanded(!expanded)}
                onKeyDown={onHeaderKeyDown}
                data-working-section-header=""
                data-mesura-nav-stop=""
                data-testid="sidebar-working-shelf-toggle"
                accessory={
                  redesign || !expanded ? (
                    <span className="font-normal tabular-nums">{count}</span>
                  ) : null
                }
              />
            }
          >
            Working
          </TooltipTrigger>
          <TooltipPopup side="right">
            {action}
            {shortcutLabel === null ? null : (
              <>
                {" "}
                <Kbd size="compact">{shortcutLabel}</Kbd>
              </>
            )}
          </TooltipPopup>
        </Tooltip>
      </div>
      <ul role="presentation" className="flex flex-col gap-px">
        {props.children}
      </ul>
      <div aria-hidden className="mx-2 my-1 h-px bg-sidebar-border/60" />
    </div>
  );
}
