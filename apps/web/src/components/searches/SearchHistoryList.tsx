import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { THREAD_SEARCH_DEFAULT_TITLE, type ScopedThreadRef } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { sameSearch, selectSearchHistory } from "./agentSearchPopup.logic";

/**
 * Mesura: earlier searches, read from the search project's thread shells
 * rather than full conversation subscriptions. A search that never got its
 * first message stays out, unless it is the one on screen.
 */
export function SearchHistoryList(props: {
  readonly activeSearch: ScopedThreadRef | null;
  readonly onSelect: (search: ScopedThreadRef) => void;
  readonly onDelete: (search: ScopedThreadRef) => void;
}) {
  const threads = useQuietThreadShells();
  const searches = selectSearchHistory(threads).filter(
    (thread) => isStarted(thread) || sameSearch(props.activeSearch, refOf(thread)),
  );
  return (
    <nav aria-label="Earlier searches" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
      {searches.length === 0 ? (
        <p className="px-2 py-3 text-sm text-muted-foreground">Earlier searches appear here.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {searches.map((thread) => {
            const search = refOf(thread);
            const active = sameSearch(props.activeSearch, search);
            const timestamp = thread.latestUserMessageAt ?? thread.createdAt;
            return (
              <li
                key={`${thread.environmentId}:${thread.id}`}
                data-search-history-entry=""
                className={cn(
                  "group flex items-start gap-1 rounded-md hover:bg-accent",
                  active && "bg-accent",
                )}
              >
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  className="min-w-0 flex-1 px-2 py-1.5 text-start"
                  onClick={() => props.onSelect(search)}
                >
                  <span className="line-clamp-2 text-sm font-medium">{thread.title}</span>
                  <time dateTime={timestamp} className="text-xs text-muted-foreground">
                    {formatRelativeTimeLabel(timestamp)}
                  </time>
                </button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Delete search ${thread.title}`}
                  onClick={() => props.onDelete(search)}
                >
                  <Trash2Icon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

function refOf(thread: EnvironmentThreadShell): ScopedThreadRef {
  return scopeThreadRef(thread.environmentId, thread.id);
}

function isStarted(thread: EnvironmentThreadShell): boolean {
  return (
    thread.latestUserMessageAt !== null ||
    thread.latestRun !== null ||
    thread.title !== THREAD_SEARCH_DEFAULT_TITLE
  );
}
