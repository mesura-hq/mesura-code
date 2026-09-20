/**
 * The finder's state: one index, one query, one set of rows.
 *
 * Separated from the overlay so the parts with rules — when a search runs, and
 * when the rows may be acted on — are testable without a keyboard, and so the
 * overlay stays a rendering of them.
 *
 * **The debounce is the first of two stages, not the only one.** 100 ms here on
 * the query, and 150 ms in the information panel on the preview. The research
 * recorded the split as the correct design and it is: a search is cheap and a
 * preview is expensive, so one shared interval either makes typing feel laggy
 * or spawns a preview per row while a movement key is held.
 *
 * **Closing the finder does NOT release the index, and that is deliberate.**
 * `releaseSearchIndex` exists and is left for a host to call; the file manager
 * does not, because reopening the finder is the common case — type, Escape,
 * think, type again — and releasing would make the second open pay for a whole
 * fresh scan of the tree. The pool's idle sweep retires a worker nobody has
 * searched for five minutes, which is the bound that matters. Do not "fix" this
 * by releasing on unmount.
 *
 * **A reply is checked against the query it answers.** The effect's own cleanup
 * already drops a reply for an abandoned query, but the reply carries
 * `matchedQuery` precisely so the check does not depend on that: without it the
 * highlighter draws the answer to "fo" against input that now reads "form".
 */
import { isFailure, type SearchReply, type SearchReplyRow } from "@symmetria/fm-core/contract";
import { useCallback, useEffect, useState } from "react";

import { recordSearchOpen, searchIn, startSearchIndex } from "./bridge.ts";

/** How long typing settles before a search runs. Qt uses the same figure. */
export const SEARCH_DEBOUNCE_MS = 100;

export interface Finder {
  readonly query: string;
  setQuery(next: string): void;
  readonly rows: readonly SearchReplyRow[];
  /** The engine had more matches than `cap`. */
  readonly truncated: boolean;
  readonly cap: number;
  /**
   * The visible rows do not answer the query as typed.
   *
   * What the confirm key is blocked on. Without it, pressing Enter while
   * results are updating opens whichever file the older list had under the
   * highlight — the user acts on one thing and gets another.
   */
  readonly stale: boolean;
  /** The first scan is still running. */
  readonly indexing: boolean;
  readonly problem: string | null;
  /** Attribute a chosen file to the query that found it. */
  record(chosenPath: string): void;
}

export function useFinder(directory: string): Finder {
  const [query, setQuery] = useState("");
  const [reply, setReply] = useState<SearchReply | null>(null);
  const [indexState, setIndexState] = useState<"indexing" | "ready" | "failed">("indexing");
  const [problem, setProblem] = useState<string | null>(null);

  // Trimmed once, here, because it is what the search is keyed on as well as
  // what it sends. Trimming at the call site instead would let the effect
  // re-run for a trailing space that changes no result.
  const wanted = query.trim();

  useEffect(() => {
    let live = true;
    setIndexState("indexing");
    setProblem(null);
    // Dropped, not kept. Rows from the previous tree would otherwise stay on
    // screen, and a reply whose `matchedQuery` happened to equal the new query
    // would read as current and let the confirm key act on a row from a
    // directory nobody is looking at. Unreachable in the file manager, whose
    // modal gate blocks navigation while the overlay is up — but this component
    // is built to be mounted by a host that has no such gate.
    setReply(null);
    void startSearchIndex(directory).then((opened) => {
      if (!live) return;
      setIndexState(isFailure(opened) ? "failed" : "ready");
      // An index that failed to open and an index with no matches look
      // identical on screen, and only one of them is something the user can act
      // on. The privileged half reports the failure HERE rather than letting
      // the first query discover it.
      if (isFailure(opened)) setProblem(opened.error.message);
    });
    return () => {
      live = false;
    };
  }, [directory]);

  useEffect(() => {
    // Suggestions also use the index. A failed scan must keep its error rather
    // than issue an automatic empty query that can replace the error.
    if (indexState !== "ready") return;

    let live = true;
    const timer = setTimeout(() => {
      void searchIn(directory, wanted).then((answered) => {
        if (!live) return;
        if (isFailure(answered)) {
          setProblem(answered.error.message);
          return;
        }
        // The reply names its own query, so a reply that overtook a newer one
        // is discarded on its own evidence rather than on this effect's timing.
        if (answered.value.matchedQuery !== wanted) return;
        setProblem(null);
        setReply(answered.value);
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [directory, wanted, indexState]);

  const record = useCallback(
    (chosenPath: string) => recordSearchOpen(directory, wanted, chosenPath),
    [directory, wanted],
  );

  return {
    query,
    setQuery,
    rows: reply?.rows ?? [],
    truncated: reply?.truncated ?? false,
    cap: reply?.cap ?? 0,
    stale: indexState !== "ready" || problem !== null || reply?.matchedQuery !== wanted,
    indexing: indexState === "indexing",
    problem,
    record,
  };
}
