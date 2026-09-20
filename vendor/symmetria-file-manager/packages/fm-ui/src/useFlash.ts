import type { EntrySummary, FsEntry } from "@symmetria/fm-core/entry";
import {
  computeFlash,
  type FlashCandidate,
  type FlashColumn,
  type FlashLabelling,
} from "@symmetria/fm-core/flash/labels";
import {
  type FlashOutcome,
  type FlashState,
  flashKey,
  newFlashState,
} from "@symmetria/fm-core/flash/session";
import { useCallback, useMemo, useRef, useState } from "react";

import type { VisibleRange } from "./components/FileList.tsx";
import type { FlashRowLabel } from "./components/FlashName.tsx";

/**
 * The host's half of flash jump.
 *
 * `fm-core/flash` decides which names match, which key jumps to each, and what
 * every key means. This owns the things that only exist in a window: which
 * rows are candidates, where the cursor was when the session started, and what
 * a jump actually does to the pane.
 *
 * ── A session's candidates are FIXED when it starts ─────────────────────────
 * The rows on screen when `s` is pressed are the rows it can label, for as long
 * as it runs. Nothing on the keyboard can scroll a column mid-session — every
 * key belongs to the session — so the only way to move the viewport under one
 * is a mouse wheel, and the plan settled that case explicitly: the labels stay
 * where they were computed, and relabelling on scroll is a named follow-up
 * rather than part of this. Review found the code tracking the live range
 * instead, which is a different feature from the one that was approved.
 *
 * ── Why this one is NOT focus-driven, unlike search ─────────────────────────
 * `useSearch` needs no key handling because its field is a real `<input>` and
 * the DOM decides. Flash has no field — it reads the raw key stream — so the
 * cascade has to be told a session is running, and `useKeyDispatch` routes
 * every key here while it is. That is what makes `j` a character instead of a
 * cursor move.
 */

export interface Flash {
  /** True while a session is running. Feeds the cascade's `flashActive`. */
  readonly active: boolean;
  /**
   * What the status bar draws, or null when no session is running.
   *
   * A ready-made shape rather than a query plus a flag, mirroring
   * `picker.chrome` next door: the alternative puts a ternary in `App`, which
   * is already at the complexity gate's shoulder.
   */
  readonly chrome: { readonly query: string } | null;
  /** Labels for each column, by row index within that column. */
  readonly labels: ColumnLabels;
  /** Begin a session, remembering where the cursor is. */
  start(): void;
  /** Discard a session when its tab or view loses ownership; do not restore its cursor. */
  clear(): void;
  /**
   * Tell the hook which rows one column has on screen.
   *
   * Stable, so a column may pass it straight to an effect. It writes a ref and
   * triggers no render — scrolling must not re-render the window — and a
   * RUNNING session does not read it: the ranges it labels against were taken
   * when it started. What this keeps current is what the NEXT session starts
   * from.
   */
  reportVisibleRange(column: FlashColumn, range: VisibleRange): void;
  /** Hand one key to the session. */
  onKey(event: KeyboardEvent): boolean;
}

/** What one previewed directory offers a session. */
export interface PreviewedDirectory {
  readonly path: string;
  readonly entries: readonly EntrySummary[];
}

export interface FlashHost {
  readonly entries: readonly FsEntry[];
  readonly cursorIndex: number;
  /** Where the pane is. Changing it ends any session. */
  readonly path: string;
  /** The column you came from, and where it lives. */
  readonly parentEntries: readonly FsEntry[];
  readonly parentPath: string;
  /**
   * The directory under the cursor, once its listing has arrived.
   *
   * `null` while the cursor is on a file, and also for the 150 ms after a
   * cursor move, during which the preview still describes the PREVIOUS entry.
   * The caller decides both; a stale directory here would offer labels that
   * navigate somewhere the user is no longer pointing at.
   */
  readonly previewDirectory: PreviewedDirectory | null;
  moveTo(index: number): void;
  navigateTo(path: string, name: string): void;
}

/** One map per column, each keyed by the row index within that column. */
export interface ColumnLabels {
  readonly current: ReadonlyMap<number, FlashRowLabel>;
  readonly preview: ReadonlyMap<number, FlashRowLabel>;
  readonly parent: ReadonlyMap<number, FlashRowLabel>;
}

/**
 * Where the cursor was when a session started, by NAME and by index.
 *
 * By name first, because the listing can change under a running session — a
 * download lands, a watcher refreshes — and an index that was right when `s`
 * was pressed then addresses a different file. The index survives only as the
 * fallback for when the remembered entry is gone.
 */
interface CursorMemory {
  readonly index: number;
  readonly name: string;
}

/** Where cancelling should put the cursor, in the listing as it stands now. */
function restoreIndex(memory: CursorMemory, entries: readonly { readonly name: string }[]): number {
  const byName = entries.findIndex((entry) => entry.name === memory.name);
  if (byName >= 0) return byName;
  return Math.min(memory.index, Math.max(entries.length - 1, 0));
}

/**
 * Do what one outcome says: put the cursor back, move it, or navigate.
 *
 * A module function rather than a branch inside the callback, because the hook
 * is scored as one function and this is four of its branches. It performs and
 * decides nothing else — the engine already decided.
 */
function perform(outcome: FlashOutcome, host: FlashHost, restore: CursorMemory): void {
  if (outcome.kind === "cancel") {
    host.moveTo(restoreIndex(restore, host.entries));
    return;
  }
  if (outcome.kind !== "jump") return;
  if (outcome.match.column === "current") {
    host.moveTo(outcome.match.index);
    return;
  }

  const destination = destinationOf(host, outcome.match.column);
  if (destination !== null) host.navigateTo(destination, outcome.match.name);
}

/**
 * Where a jump into a column other than the current one is going.
 *
 * `null` when there is nowhere — the previewed directory can go away between
 * the moment a label is drawn and the moment it is pressed, and navigating on
 * a guess would be worse than doing nothing.
 */
function destinationOf(host: FlashHost, column: FlashColumn): string | null {
  if (column === "parent") return host.parentPath;
  return host.previewDirectory?.path ?? null;
}

/**
 * Everything, until a column says otherwise.
 *
 * A host that never reports gets the Qt behaviour — every match labelled —
 * rather than no labels at all. A feature that silently does nothing is the
 * worse failure of the two, and the renderer tests catch a broken wiring
 * anyway, because a label would then appear on a row that is off screen.
 */
const EVERYTHING: VisibleRange = { start: 0, end: Number.MAX_SAFE_INTEGER };

/** One visible range per column. A named shape, not a dictionary. */
interface ColumnRanges {
  current: VisibleRange;
  preview: VisibleRange;
  parent: VisibleRange;
}

function everywhere(): ColumnRanges {
  return { current: EVERYTHING, preview: EVERYTHING, parent: EVERYTHING };
}

/**
 * The candidates a session may label: the rows on screen, and no others.
 *
 * The one place this port departs from the Qt build. Qt labels every match in
 * the listing, so it hands out labels nobody can read and spends the
 * single-character pool on them.
 *
 * Filtered rather than sliced, because the candidates of all three columns
 * arrive in one list and each has its own window. Filtering also leaves every
 * candidate's `index` alone, which is what a jump lands on.
 */
function onScreen(
  candidates: readonly FlashCandidate[],
  ranges: ColumnRanges,
  columns: ReadonlySet<FlashColumn>,
): readonly FlashCandidate[] {
  return candidates.filter((candidate) => {
    if (!columns.has(candidate.column)) return false;
    const range = ranges[candidate.column];
    return candidate.index >= range.start && candidate.index <= range.end;
  });
}

/** Labels for every column, keyed by the row they belong to. */
function labelsFor(session: FlashState | null): ColumnLabels {
  const byColumn = {
    current: new Map<number, FlashRowLabel>(),
    preview: new Map<number, FlashRowLabel>(),
    parent: new Map<number, FlashRowLabel>(),
  };
  if (session === null) return byColumn;

  for (const match of session.labelling.matches) {
    // An unlabelled match has nothing to press, so it is not drawn as a match
    // and dims with the rest. That is the Qt behaviour and it is the honest
    // one: a highlight offering no key is a highlight that lies.
    if (match.label === "") continue;
    byColumn[match.column].set(match.index, {
      query: session.query,
      label: match.label,
      matchStart: match.matchStart,
    });
  }
  return byColumn;
}

/** No rows. A shared instance, so an absent column does not churn the memo. */
const NO_ENTRIES: readonly { readonly name: string }[] = [];

/** Every candidate the three columns offer, each tagged with where it lives. */
function candidatesOf(
  current: readonly { readonly name: string }[],
  preview: readonly { readonly name: string }[],
  parent: readonly { readonly name: string }[],
): FlashCandidate[] {
  const named = (names: readonly { readonly name: string }[], column: FlashColumn) =>
    names.map((entry, index) => ({ name: entry.name, column, index }));

  return [...named(current, "current"), ...named(preview, "preview"), ...named(parent, "parent")];
}

interface UpkeepInputs {
  readonly path: string;
  readonly candidates: readonly FlashCandidate[];
  readonly refs: SessionRefs;
  readonly setSession: (session: FlashState | null) => void;
  readonly relabel: (query: string) => FlashLabelling;
}

/**
 * Keep a running session true to the ground it was computed against.
 *
 * Both adjustments happen DURING render rather than in an effect. An effect
 * would have to list an input its body never reads — which the lint rule
 * reports, correctly — and it would let one frame paint with labels addressing
 * rows that have gone.
 *
 * **Leaving the directory ends the session.** Its labels address a listing that
 * is being replaced wholesale.
 *
 * **A listing that changes without the pane moving relabels instead** — a
 * watcher refresh, a re-sort, a download landing, a previewed directory
 * arriving. This is not tidiness: a label carries the index it was computed
 * for, and the jump goes to that index, so a session that outlived one
 * inserted row would draw its labels over the wrong names and then move to the
 * wrong file, silently and plausibly. Review found this. The Qt build has the
 * same gap between two keystrokes and it is worse here, because nothing else
 * rebuilds the candidate list.
 *
 * A held prefix does NOT survive a relabelling: a fresh pass can hand its first
 * character to a different match, so what the user half-typed no longer means
 * what they read.
 */
function useSessionUpkeep({ path, candidates, refs, setSession, relabel }: UpkeepInputs): void {
  const [pathSeen, setPathSeen] = useState(path);
  const [candidatesSeen, setCandidatesSeen] = useState(candidates);

  if (pathSeen !== path) {
    setPathSeen(path);
    setCandidatesSeen(candidates);
    refs.live = null;
    setSession(null);
    return;
  }

  if (candidatesSeen === candidates) return;
  setCandidatesSeen(candidates);

  const running = refs.live;
  if (running === null) return;

  const relabelled = { ...running, pendingLabel: "", labelling: relabel(running.query) };
  refs.live = relabelled;
  setSession(relabelled);
}

/**
 * Everything a keypress needs, in one place that render keeps current.
 *
 * A single ref rather than six, because `onKey` is attached once and reads
 * through it: two keys can arrive before React re-renders — a held key repeats
 * faster than a commit — and reading state would hand the second key the state
 * the first one replaced. Deriving the next state inside a `setState` updater
 * would fix that and introduce a worse problem, since a jump moves the cursor
 * and React may call an updater more than once.
 */
interface SessionRefs {
  /** The running session. `null` between sessions. */
  live: FlashState | null;
  /** Where the cursor was when it started. */
  restoreTo: CursorMemory;
  /** Each column's viewport, always current. */
  visible: ColumnRanges;
  /** The viewports this session labels against. Frozen at `start`. */
  labelling: ColumnRanges;
  /**
   * Which columns this session may label. Frozen at `start`.
   *
   * A session's ROWS may be relabelled under it — a watcher refresh, a
   * download landing — because a label carries an index and a stale index
   * jumps to the wrong file. A whole COLUMN is a different thing. The
   * previewed directory arrives 150 ms after the cursor lands on one, so a
   * session started inside that window would gain a third column part-way
   * through and every label would move: verification watched the parent
   * column's `g` and `h` become `k` and `l` while it ran. A label the user has
   * already read must not change what it means.
   */
  columns: ReadonlySet<FlashColumn>;
  candidates: readonly FlashCandidate[];
  host: FlashHost;
}

/** What the status bar draws for a session, or nothing. */
function chromeOf(session: FlashState | null): { readonly query: string } | null {
  return session === null ? null : { query: session.query };
}

/**
 * Hand one key to the session and apply whatever it decides.
 *
 * A module function rather than a body inside the callback, because the hook is
 * scored as one function and this is most of its branching.
 */
function pressKey(
  event: KeyboardEvent,
  refs: SessionRefs,
  setSession: (session: FlashState | null) => void,
  relabel: (query: string) => FlashLabelling,
): void {
  const current = refs.live;
  if (current === null) return;

  const outcome = flashKey(current, { key: event.key }, relabel);
  if (outcome.kind === "state") {
    refs.live = outcome.state;
    setSession(outcome.state);
    return;
  }

  refs.live = null;
  setSession(null);
  // Cancelling puts the cursor back where the session started. A jump in the
  // current column moves the cursor; a jump in either other column navigates
  // and lands on the entry that was labelled.
  perform(outcome, refs.host, refs.restoreTo);
}

export function useFlash(host: FlashHost): Flash {
  const [session, setSession] = useState<FlashState | null>(null);

  // Keyed on the three ARRAYS, not on the host object. The host is rebuilt on
  // every render of the window; its listings are not, and rebuilding the
  // candidates for an unchanged listing would make `useSessionUpkeep` relabel
  // on every render — which is a render loop, not a slow path.
  const previewEntries = host.previewDirectory?.entries ?? NO_ENTRIES;
  const candidates = useMemo<FlashCandidate[]>(
    () => candidatesOf(host.entries, previewEntries, host.parentEntries),
    [host.entries, previewEntries, host.parentEntries],
  );

  const refs = useRef<SessionRefs>({
    live: null,
    restoreTo: { index: 0, name: "" },
    visible: everywhere(),
    labelling: everywhere(),
    columns: new Set<FlashColumn>(),
    candidates,
    host,
  });
  refs.current.candidates = candidates;
  refs.current.host = host;

  const reportVisibleRange = useCallback((column: FlashColumn, range: VisibleRange) => {
    refs.current.visible[column] = range;
  }, []);

  const relabel = useCallback(
    (query: string) =>
      computeFlash(
        query,
        onScreen(refs.current.candidates, refs.current.labelling, refs.current.columns),
        refs.current.host.cursorIndex,
      ),
    [],
  );

  const clear = useCallback(() => {
    refs.current.live = null;
    setSession(null);
  }, []);

  const start = useCallback(() => {
    const { host: current } = refs.current;
    refs.current.restoreTo = {
      index: current.cursorIndex,
      name: current.entries[current.cursorIndex]?.name ?? "",
    };
    refs.current.labelling = { ...refs.current.visible };
    refs.current.columns = new Set(refs.current.candidates.map((candidate) => candidate.column));
    const fresh = newFlashState();
    refs.current.live = fresh;
    setSession(fresh);
  }, []);

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      pressKey(event, refs.current, setSession, relabel);
      // An active Miller flash session owns the key, including cancellation.
      return true;
    },
    [relabel],
  );

  useSessionUpkeep({ path: host.path, candidates, refs: refs.current, setSession, relabel });

  const labels = useMemo(() => labelsFor(session), [session]);

  const chrome = useMemo(() => chromeOf(session), [session]);

  return { active: session !== null, chrome, labels, start, clear, reportVisibleRange, onKey };
}
