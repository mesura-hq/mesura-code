/**
 * Where a tab has been, and where it can return to.
 *
 * Two stacks and the browser's rule: going somewhere new throws the forward
 * trail away, because the branch you did not take is not somewhere you chose.
 *
 * **The current path is deliberately NOT held here.** It lives in the pane, and
 * every operation takes it as an argument instead. One copy cannot disagree
 * with itself — and the situation where a second copy would drift is the one
 * nobody writes a test for: a listing that fails and sends the pane back to its
 * last good path on its own, which is a repair rather than a place the user
 * went, and must leave no trace in the trail at all.
 */
export interface History {
  /** Where to go on the way back, oldest first. */
  readonly back: readonly string[];
  /** Where to return to, nearest first. */
  readonly forward: readonly string[];
}

/** One step, and the history it leaves behind. */
export interface HistoryStep {
  readonly history: History;
  readonly path: string;
}

const EMPTY: History = { back: [], forward: [] };

export function emptyHistory(): History {
  return EMPTY;
}

/**
 * Record leaving `from`, on the way to somewhere new.
 *
 * Takes the path being LEFT rather than the one being entered, because that is
 * the one a step back returns to — and because the pane already knows where it
 * is going. The forward trail is discarded here and nowhere else.
 */
export function visit(history: History, from: string): History {
  return { back: [...history.back, from], forward: [] };
}

/**
 * Go back one, or report that there is nowhere to go.
 *
 * It does NOT call `visit`. That is the whole of criterion 6: a backward step
 * that recorded itself would put the place it just left onto the back stack,
 * and the next press would return there — the cursor oscillating between two
 * directories for ever, one press behind the user.
 */
export function stepBack(history: History, current: string): HistoryStep | null {
  const path = history.back[history.back.length - 1];
  if (path === undefined) return null;

  return {
    history: {
      back: history.back.slice(0, -1),
      forward: [current, ...history.forward],
    },
    path,
  };
}

/** Go forward one, or report that there is nowhere to go. */
export function stepForward(history: History, current: string): HistoryStep | null {
  const path = history.forward[0];
  if (path === undefined) return null;

  return {
    history: {
      back: [...history.back, current],
      forward: history.forward.slice(1),
    },
    path,
  };
}
