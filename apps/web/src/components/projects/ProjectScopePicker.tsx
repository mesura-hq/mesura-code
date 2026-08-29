import { useAtomValue } from "@effect/atom-react";
import { FolderIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProjectScopeGroups } from "~/hooks/useProjectScopeGroups";
import { useProjectScopeStore } from "~/projectScopeStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { CommandPaletteContent } from "../CommandPaletteContent";
import { findJumpTargetItem, normalizeSearchText } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { ProjectFavicon } from "../ProjectFavicon";
import { buildProjectScopeItems } from "./projectScopePicker.logic";

/**
 * Filters the sidebar's thread list to one project.
 *
 * It writes the same store the sidebar's own project menu writes, so the two
 * are one filter rather than two that drift. Picking a project never navigates:
 * the thread being read stays open, and only the list beside it narrows.
 */
export function ProjectScopePicker(props: { readonly setOpen: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const groups = useProjectScopeGroups();
  const setProjectScopeKey = useProjectScopeStore((store) => store.setProjectScopeKey);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const items = useMemo(
    () =>
      buildProjectScopeItems({
        groups,
        renderIcon: (group) => (
          <ProjectFavicon
            environmentId={group.environmentId}
            cwd={group.workspaceRoot}
            faviconPath={group.faviconPath}
            className="size-4 shrink-0"
          />
        ),
        allProjectsIcon: <FolderIcon className="size-4 shrink-0 text-icon-muted" />,
        onScope: (projectScopeKey) => {
          setProjectScopeKey(projectScopeKey);
          props.setOpen(false);
        },
      }),
    [groups, props.setOpen, setProjectScopeKey],
  );

  const visibleItems = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    if (normalizedQuery.length === 0) return items;

    return items.filter((item) =>
      item.searchTerms.some((term) => normalizeSearchText(term).includes(normalizedQuery)),
    );
  }, [items, query]);

  return (
    <CommandPaletteContent
      aria-label="Filter threads by project"
      autoHighlight="always"
      escapeLabel="Back"
      footerActionLabel="Filter by project"
      inputProps={{
        placeholder: "Filter threads by project…",
        // The rows are numbered, so the press has to reach a row before the
        // sidebar's own mod+1..9 thread jump sees it. preventDefault is what
        // stops that handler, which bails on an already-handled event.
        onKeyDown: (event) => {
          const target = findJumpTargetItem({
            event,
            keybindings,
            items: visibleItems,
            platform: navigator.platform,
          });
          if (!target || target.kind !== "action") return;

          event.preventDefault();
          event.stopPropagation();
          void target.run();
        },
      }}
      mode="none"
      panelClassName="max-h-[min(34rem,76vh)]"
      testId="project-scope-picker"
      value={query}
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
    >
      <CommandPaletteResults
        groups={
          visibleItems.length > 0
            ? [{ value: "project-scope", label: "Projects", items: visibleItems }]
            : []
        }
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action") return;
          void item.run();
        }}
        emptyStateMessage="No matching projects."
      />
    </CommandPaletteContent>
  );
}
