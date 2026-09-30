import { useAtomValue } from "@effect/atom-react";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  selectThreadContentToken,
  tokenizeThreadSearchQuery,
} from "@t3tools/client-runtime/state/thread-token-search";
import { useParams } from "@tanstack/react-router";
import { SparklesIcon, TextSearchIcon } from "lucide-react";
import { type ReactNode, type RefObject, useDeferredValue, useMemo, useState } from "react";

import { useConnectedEnvironmentIds, useThreadCommandItems } from "~/hooks/useThreadCommandItems";
import { useProjects, useThreadShells } from "~/state/entities";
import { useThreadSearch } from "~/state/queries";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import { findJumpTargetItem } from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  AgentThreadSearch,
  handleThreadSearchModeKey,
  ThreadSearchModeHint,
  type ThreadSearchBackHandler,
} from "./AgentThreadSearch";
import { buildThreadSearchCandidates, buildThreadSearchGroups } from "./threadSearchPicker.logic";
import { useAgentThreadSearchSession } from "./AgentThreadSearchSession";

type ThreadSearchMode = "exact" | "agent";

/**
 * The picker's two modes as one segmented control beside the field. Each
 * segment reports its state through `aria-pressed`, and the field keeps focus
 * after a switch because the mode's own content mounts with it focused.
 */
function ThreadSearchModeSwitch(props: {
  readonly mode: ThreadSearchMode;
  readonly onModeChange: (mode: ThreadSearchMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Search mode"
      className="absolute inset-e-2.5 top-1/2 shrink-0 -translate-y-1/2"
      variant="segmented"
      value={[props.mode]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "exact" || next === "agent") props.onModeChange(next);
      }}
    >
      <Toggle className="gap-1" value="exact">
        <TextSearchIcon className="size-3.5" />
        Exact
      </Toggle>
      <Toggle className="gap-1" value="agent">
        <SparklesIcon className="size-3.5" />
        Agent
      </Toggle>
    </ToggleGroup>
  );
}

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
 *
 * Tab or the mode switch trades exact words for `AgentThreadSearch`, where the
 * user describes the thread instead.
 */
export function ThreadSearchPicker(props: {
  readonly setOpen: (open: boolean) => void;
  /** Where the active mode offers the palette its own Escape step. */
  readonly backHandlerRef: RefObject<ThreadSearchBackHandler | null>;
}) {
  const session = useAgentThreadSearchSession();
  // Reopening the picker resumes the conversation when one exists.
  const [mode, setMode] = useState<ThreadSearchMode>(() =>
    session.turns.length > 0 || session.draft.length > 0 ? "agent" : "exact",
  );
  const modeSwitch = <ThreadSearchModeSwitch mode={mode} onModeChange={setMode} />;

  if (mode === "agent") {
    return (
      <AgentThreadSearch
        backHandlerRef={props.backHandlerRef}
        modeSwitch={modeSwitch}
        setOpen={props.setOpen}
        onExitAgentMode={() => setMode("exact")}
      />
    );
  }
  return (
    <ExactThreadSearch
      modeSwitch={modeSwitch}
      setOpen={props.setOpen}
      onEnterAgentMode={() => setMode("agent")}
    />
  );
}

function ExactThreadSearch(props: {
  readonly modeSwitch: ReactNode;
  readonly setOpen: (open: boolean) => void;
  readonly onEnterAgentMode: () => void;
}) {
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
      footerTrailing={<ThreadSearchModeHint target="Agent search" />}
      inputAccessory={props.modeSwitch}
      inputProps={{
        className: "pe-40",
        placeholder: "Search every thread…",
        // The rows are numbered, so a mod+1..9 press has to reach a row before
        // the sidebar's own thread jump sees it. preventDefault is what stops
        // that handler, which bails on an already-handled event.
        onKeyDown: (event) => {
          if (handleThreadSearchModeKey(event, props.onEnterAgentMode)) return;
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
