import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useRef } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Kbd } from "../ui/kbd";
import { SidebarSeparateSection } from "./SidebarSeparateSection";
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
  const seen = useSeenOnScreen(sectionRef);
  useWorkingSweep(sectionRef, expanded && seen && count > 0);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggleWorking");
  const action = expanded ? "Collapse working threads" : "Show working threads";

  return (
    <div ref={sectionRef} data-working-section="" data-testid="sidebar-working-section">
      {/* Sticky inside its own block on desktop: it rides the top while working rows scroll under
          it, then leaves with them. The phone drawer's surface sits outside `[data-app-sidebar]`,
          whose `--sidebar` differs, so a sticky background there shows as a dark bar. */}
      <SidebarSeparateSection
        rowId="shelf:working"
        label="Working"
        expanded={expanded}
        onToggle={() => setWorkingSectionExpanded(!expanded)}
        headerWrapperClassName="md:sticky md:top-0 md:z-20 md:bg-sidebar md:surface-grain"
        headerAttributes={{
          "data-working-section-header": "",
          "data-testid": "sidebar-working-shelf-toggle",
        }}
        accessory={<span className="font-normal tabular-nums">{count}</span>}
        tooltip={
          <>
            {action}
            {shortcutLabel === null ? null : (
              <>
                {" "}
                <Kbd size="compact">{shortcutLabel}</Kbd>
              </>
            )}
          </>
        }
      >
        {props.children}
      </SidebarSeparateSection>
      <div aria-hidden className="mx-2 my-1 h-px bg-sidebar-border/60" />
    </div>
  );
}
