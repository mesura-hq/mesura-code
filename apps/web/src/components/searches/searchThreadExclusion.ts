/**
 * Mesura: search conversations live in a hidden project (docs/mesura/adr-010-search-chats.md).
 * The server keeps them in the shell snapshot for the popup, so client lists drop them here.
 * Results are cached per input array, and an input without search items comes back unchanged.
 */
import { THREAD_SEARCH_PROJECT_ID } from "@t3tools/contracts";

const threadCache = new WeakMap<ReadonlyArray<unknown>, ReadonlyArray<unknown>>();
const projectCache = new WeakMap<ReadonlyArray<unknown>, ReadonlyArray<unknown>>();

function withoutCached<T>(
  cache: WeakMap<ReadonlyArray<unknown>, ReadonlyArray<unknown>>,
  items: ReadonlyArray<T>,
  isSearchItem: (item: T) => boolean,
): ReadonlyArray<T> {
  const cached = cache.get(items);
  if (cached) return cached as ReadonlyArray<T>;
  const kept = items.some(isSearchItem) ? items.filter((item) => !isSearchItem(item)) : items;
  cache.set(items, kept);
  return kept;
}

export function withoutSearchThreads<T extends { readonly projectId: string }>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return withoutCached(
    threadCache,
    threads,
    (thread) => thread.projectId === THREAD_SEARCH_PROJECT_ID,
  );
}

export function withoutSearchProject<T extends { readonly id: string }>(
  projects: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return withoutCached(
    projectCache,
    projects,
    (project) => project.id === THREAD_SEARCH_PROJECT_ID,
  );
}
