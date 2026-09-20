import type { FsEntry } from "@symmetria/fm-core/entry";
import { computeTextMatches, nextMatch, previousMatch } from "@symmetria/fm-core/search";
import { useEffect, useMemo, useRef, useState } from "react";

export interface Search {
  readonly active: boolean;
  readonly query: string;
  readonly matches: ReadonlySet<number>;
  readonly matchCount: number;
  open(): void;
  setQuery(query: string): void;
  confirm(): void;
  cancel(): void;
  goNext(): void;
  goPrevious(): void;
}
export interface SearchHost {
  readonly entries: readonly FsEntry[];
  readonly cursorIndex: number;
  readonly path: string;
  moveTo(index: number): void;
}
interface SearchTarget {
  readonly key: string;
  readonly text: string;
}
interface SearchSessionHost {
  readonly targets: readonly SearchTarget[];
  readonly scope: string;
  readonly selected: string;
  readonly followReload?: boolean;
  choose(key: string): void;
  capture?(): void;
  restore?(key: string): void;
}

/** Shared search state; each host supplies identity, searchable text and navigation. */
export function useSearchSession(host: SearchSessionHost) {
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<string | null>(null);
  const restoreTo = useRef("");
  const latest = useRef(host);
  latest.current = host;
  const matching = useMemo(() => {
    const indices = computeTextMatches(host.targets, query, (target) => target.text);
    return indices.flatMap((index) => {
      const target = host.targets[index];
      return target ? [target.key] : [];
    });
  }, [host.targets, query]);
  const matches = useMemo(() => new Set(matching), [matching]);
  const previousQuery = useRef(query);
  useEffect(() => {
    const current = latest.current;
    const typed = previousQuery.current !== query;
    previousQuery.current = query;
    if (typed) {
      const first = matching[0];
      setAnchor(first ?? null);
      if (active && first !== undefined) current.choose(first);
      return;
    }
    const chosen = reloadTarget(current, matching, matches);
    if (chosen !== undefined) setAnchor(chosen);
    // A confirmed search updates its identity without moving the cursor.
    if (active && current.followReload && chosen !== undefined) current.choose(chosen);
  }, [active, matching, matches, query]);

  const clear = () => {
    setActive(false);
    setQuery("");
    setAnchor(null);
  };
  const previousScope = useRef(host.scope);
  if (previousScope.current !== host.scope) {
    previousScope.current = host.scope;
    previousQuery.current = "";
    if (active || query !== "") clear();
  }
  const step = (backwards: boolean) => {
    const next = searchStep(matching, anchor, backwards, host.followReload ?? false);
    const key = matching[next];
    if (key === undefined) return;
    setAnchor(key);
    latest.current.choose(key);
  };
  return {
    active,
    query,
    matches,
    matchCount: matching.length,
    position: matching.indexOf(host.selected) + 1,
    setQuery,
    clear,
    open: () => {
      restoreTo.current = host.selected;
      host.capture?.();
      setQuery("");
      previousQuery.current = "";
      setAnchor(null);
      setActive(true);
    },
    confirm: () => setActive(false),
    cancel: () => {
      clear();
      if (host.restore) host.restore(restoreTo.current);
      else if (host.targets.some((target) => target.key === restoreTo.current))
        host.choose(restoreTo.current);
    },
    goNext: () => step(false),
    goPrevious: () => step(true),
  };
}

/** Miller keeps its index-facing API while the shared session tracks names. */
export function useSearch(host: SearchHost): Search {
  const targets = useMemo(
    () => host.entries.map((entry) => ({ key: entry.name, text: entry.name })),
    [host.entries],
  );
  const session = useSearchSession({
    targets,
    scope: host.path,
    selected: host.entries[host.cursorIndex]?.name ?? "",
    followReload: true,
    choose: (key) => {
      const index = host.entries.findIndex((entry) => entry.name === key);
      if (index >= 0) host.moveTo(index);
    },
  });
  const matches = useMemo(
    () =>
      new Set(
        host.entries.flatMap((entry, index) => (session.matches.has(entry.name) ? [index] : [])),
      ),
    [host.entries, session.matches],
  );
  return { ...session, matches };
}

function reloadTarget(
  host: SearchSessionHost,
  matching: readonly string[],
  matches: ReadonlySet<string>,
) {
  if (matches.has(host.selected)) return host.selected;
  return host.followReload ? matching[0] : undefined;
}

function searchStep(
  matching: readonly string[],
  anchor: string | null,
  backwards: boolean,
  followReload: boolean,
): number {
  const position = anchor === null ? -1 : matching.indexOf(anchor);
  if (position >= 0 || anchor === null || followReload)
    return backwards ? previousMatch(matching, position) : nextMatch(matching, position);
  // Retain a deleted path as a lexical boundary until explicit navigation.
  const successor = matching.findIndex((key) => key > anchor);
  if (!backwards) return successor < 0 ? 0 : successor;
  return (successor <= 0 ? matching.length : successor) - 1;
}
