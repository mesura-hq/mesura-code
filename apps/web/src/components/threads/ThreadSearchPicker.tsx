import { useAtomValue } from "@effect/atom-react";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  selectThreadContentToken,
  tokenizeThreadSearchQuery,
} from "@t3tools/client-runtime/state/thread-token-search";
import { useParams } from "@tanstack/react-router";
import { useDeferredValue, useMemo, useState } from "react";

import { useConnectedEnvironmentIds, useThreadCommandItems } from "~/hooks/useThreadCommandItems";
import { useProjects, useThreadShells } from "~/state/entities";
import { useThreadSearch } from "~/state/queries";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import { findJumpTargetItem } from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { buildThreadSearchCandidates, buildThreadSearchGroups } from "./threadSearchPicker.logic";

/**
 * Finds one thread among every thread, in every project and every environment.
 *
 * The command palette lists threads too, but it joins a thread's title, project
 * and branch into one string and looks for the query contiguously inside it, so
 * it cannot answer "the rename one, in Mesura". Here the words are matched one
 * at a time and in any order.
 *
 * The sidebar's project filter does not narrow this: the picker exists to reach
 * a thread you are not currently looking at.
 */
export function ThreadSearchPicker(props: { readonly setOpen: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const projects = useProjects();
  const threads = useThreadShells();

  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeThreadId =
    routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : undefined;

  const projectTitleById = useMemo(
    () => new Map(projects.map((project) => [String(project.id), project.title] as const)),
    [projects],
  );

  const tokens = useMemo(() => tokenizeThreadSearchQuery(deferredQuery), [deferredQuery]);
  // The server matches a contiguous LIKE, so only one word can be asked for.
  const contentToken = useMemo(
    () => selectThreadContentToken(tokens, [...projectTitleById.values()]),
    [projectTitleById, tokens],
  );

  const threadSearch = useThreadSearch(useConnectedEnvironmentIds(), contentToken ?? "");
  const contentMatchByKey = useMemo(
    () =>
      new Map(
        threadSearch.matches.flatMap((match) =>
          match.source === "user" || match.source === "assistant"
            ? [[threadSearchMatchKey(match), match] as const]
            : [],
        ),
      ),
    [threadSearch.matches],
  );
  // Keyed by environment and thread together: a hit in one environment must not
  // be read as a hit in another that happens to share a thread id.
  const contentMatchKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );

  const items = useThreadCommandItems({
    activeThreadId,
    contentMatchByKey,
    contentQuery: contentToken ?? "",
  });

  const groups = useMemo(
    () =>
      buildThreadSearchGroups({
        candidates: buildThreadSearchCandidates({
          items,
          threads: threads.map((thread) => ({
            id: String(thread.id),
            projectId: String(thread.projectId),
            title: thread.title,
            branch: thread.branch,
            matchKey: threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          })),
          projectTitleById,
          contentMatchKeys,
        }),
        tokens,
        contentToken,
      }),
    [contentMatchKeys, contentToken, items, projectTitleById, threads, tokens],
  );

  const visibleItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const openItem = (item: { kind: string; run: () => Promise<void> }) => {
    void item.run();
    props.setOpen(false);
  };

  return (
    <CommandPaletteContent
      aria-label="Search threads"
      autoHighlight="always"
      escapeLabel="Back"
      footerActionLabel="Open thread"
      inputProps={{
        placeholder: "Search every thread…",
        // The rows are numbered, so a mod+1..9 press has to reach a row before
        // the sidebar's own thread jump sees it. preventDefault is what stops
        // that handler, which bails on an already-handled event.
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
          openItem(target);
        },
      }}
      mode="none"
      panelClassName="max-h-[min(34rem,76vh)]"
      testId="thread-search-picker"
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
        groups={groups}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action") return;
          openItem(item);
        }}
        emptyStateMessage={
          threadSearch.isPending ? "Searching threads…" : "No threads match that search."
        }
      />
    </CommandPaletteContent>
  );
}
