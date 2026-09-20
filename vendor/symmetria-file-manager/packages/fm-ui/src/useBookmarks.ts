import type { Bookmark } from "@symmetria/fm-core/bookmarks";
import { isFailure } from "@symmetria/fm-core/contract";
import { useCallback, useEffect, useRef, useState } from "react";

import { readBookmarks, writeBookmarks } from "./bridge.ts";

/**
 * The bookmark store, as the window sees it.
 *
 * Loaded once. The main process owns the file — where it is, seeding it on a
 * first run, writing it atomically — and this owns nothing but the copy the
 * keyboard reads. Two windows would each hold their own copy and the last write
 * would win, which is what the Qt build does too and has never mattered: a
 * bookmark is changed a handful of times a year.
 */

export interface Bookmarks {
  readonly byLetter: ReadonlyMap<string, Bookmark>;
  /** Where a letter points, or `null` when nothing is bound there. */
  pathFor(letter: string): string | null;
  /** Bind a letter, replacing whatever was on it, and persist. */
  assign(letter: string, bookmark: Bookmark): void;
  /** Unbind a letter, and persist. Unbinding an unbound letter does nothing. */
  remove(letter: string): void;
}

export function useBookmarks(): Bookmarks {
  const [byLetter, setByLetter] = useState<ReadonlyMap<string, Bookmark>>(new Map());

  useEffect(() => {
    let current = true;
    void readBookmarks().then((reply) => {
      // The window may have closed while the read was in flight.
      if (!current || isFailure(reply)) return;
      setByLetter(reply.value);
    });
    return () => {
      current = false;
    };
  }, []);

  /**
   * The tail of the write chain.
   *
   * Every write sends the WHOLE map and the main process has no notion of which
   * one is newer, so two writes in flight at once are decided by whichever
   * finishes its disk I/O last. `gn a` immediately followed by `gx b` could
   * therefore land in either order, and losing the race means a change that the
   * interface already showed as saved is quietly absent on the next start.
   *
   * Chaining is the whole fix: each write waits for the previous one, so the
   * order they reach the disk is the order they were made. It costs nothing —
   * a person binds a bookmark a handful of times a year — and it needs no
   * sequence number in the protocol.
   */
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * Apply a change and persist it.
   *
   * The state is updated from the new map rather than after the write lands: a
   * bookmark that only appears once the disk agrees would make `gn w` feel slow
   * for no reason a person can see. A failed write still leaves a store that
   * works for the session, and it is silent for the same reason the seed write
   * is — the user asked to bind a letter, not to be told about a filesystem.
   */
  const persist = useCallback((next: Map<string, Bookmark>) => {
    setByLetter(next);
    // `catch` on the chain, not on the write: one rejection must not break the
    // link and strand every write after it.
    writeChain.current = writeChain.current.then(
      () => writeBookmarks(next),
      () => writeBookmarks(next),
    );
  }, []);

  return {
    byLetter,
    pathFor: (letter) => byLetter.get(letter)?.path ?? null,
    assign: (letter, bookmark) => {
      const next = new Map(byLetter);
      next.set(letter, bookmark);
      persist(next);
    },
    remove: (letter) => {
      if (!byLetter.has(letter)) return;
      const next = new Map(byLetter);
      next.delete(letter);
      persist(next);
    },
  };
}
