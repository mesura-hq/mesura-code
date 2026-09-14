/**
 * Flash labelling: which names match, and which key jumps to each.
 *
 * The port of `FlashLogic.js` from the Qt build — the one part of flash that
 * never needed a window, and the reason the two builds can share a definition
 * of "correct" rather than two implementations that drift.
 *
 * ── The idea, which is Flash.nvim's ────────────────────────────────────────
 * A label is drawn only from characters that **cannot continue any current
 * match**. That single rule is what makes the search and the jump one gesture:
 * if the next character typed could extend the query it does, and if it could
 * not, it is a label and it jumps. The user never says which they meant,
 * because no character is ever both.
 */

/** Which Miller column a candidate lives in. */
export type FlashColumn = "current" | "preview" | "parent";

/**
 * A row a session may label.
 *
 * A name, and enough to find the row again. **No path and no kind**, although
 * the Qt original threads both through the algorithm: it reads neither, and the
 * host that supplied the candidate can resolve the column and the index back to
 * an entry itself. Keeping them out is what makes this module about characters.
 */
export interface FlashCandidate {
  readonly name: string;
  readonly column: FlashColumn;
  readonly index: number;
}

export interface FlashMatch extends FlashCandidate {
  /** The keys that jump here. `""` when the pool ran out — see `planLabels`. */
  readonly label: string;
  /** Where the query sits in the name, so the drawing can highlight it. */
  readonly matchStart: number;
}

export interface FlashLabelling {
  /** In priority order: the first is the one the eye should reach first. */
  readonly matches: readonly FlashMatch[];
  /** Characters that would extend the query. None of them is ever a label. */
  readonly continuations: ReadonlySet<string>;
  /** Every character appearing in any label, including both halves of a pair. */
  readonly labelChars: ReadonlySet<string>;
}

/**
 * The label pool, home row first.
 *
 * Byte-identical to the Qt build's, and the order is the priority: the match
 * the user most likely wants gets the key their finger is already on.
 */
export const LABEL_CHARS = "asdfghjklqwertyuiopzxcvbnm";

/** Column order for the priority sort. Lower sorts first. */
const COLUMN_RANK = { current: 0, preview: 1, parent: 2 } satisfies Record<FlashColumn, number>;

/**
 * A labelling of nothing: no match, no label, no way to extend.
 *
 * A function rather than a shared constant. The sets are `ReadonlySet` at the
 * type level and ordinary mutable `Set`s at runtime, so one shared instance
 * handed to every caller could be added to by any of them and would then
 * corrupt every later empty result for the life of the process. It costs one
 * allocation on a keystroke that matched nothing.
 */
function nothing(): FlashLabelling {
  return { matches: [], continuations: new Set(), labelChars: new Set() };
}

/**
 * Every character that immediately follows an occurrence of the query.
 *
 * **Every occurrence in every name, not the first of each.** A name holding the
 * query twice offers two ways to continue, and handing either of them out as a
 * label would make that keystroke ambiguous — which is the one thing this
 * design does not allow.
 */
function continuationChars(query: string, matches: readonly FlashMatch[]): Set<string> {
  const chars = new Set<string>();

  for (const match of matches) {
    const lower = match.name.toLowerCase();
    for (let from = lower.indexOf(query); from !== -1; from = lower.indexOf(query, from + 1)) {
      const after = lower[from + query.length];
      if (after !== undefined) chars.add(after);
    }
  }

  // The query's own characters as well. They cannot extend anything, but a
  // label repeating a character the user just typed reads as a typo.
  for (const char of query) chars.add(char);

  return chars;
}

/**
 * Priority: the current column nearest the cursor, then preview, then parent.
 *
 * Returns a new array. The Qt original sorts in place, which is safe there and
 * is not here — the candidate list belongs to the caller and may well be a
 * memoised value it will hand over again.
 */
function byPriority(matches: readonly FlashMatch[], cursorIndex: number): FlashMatch[] {
  return [...matches].sort((a, b) => {
    const columns = COLUMN_RANK[a.column] - COLUMN_RANK[b.column];
    if (columns !== 0) return columns;

    if (a.column === "current") {
      return Math.abs(a.index - cursorIndex) - Math.abs(b.index - cursorIndex);
    }
    return a.index - b.index;
  });
}

/** How many pool characters go to single labels, and how many become prefixes. */
interface LabelSplit {
  readonly singles: number;
  readonly prefixes: number;
}

/**
 * How to split the pool between single labels and two-character prefixes.
 *
 * ── The Qt version of this branch cannot run, and that is why it is here ────
 * `_assignLabels` spends `min(matches, available)` characters on single labels
 * first and only then looks for a prefix — so the prefix search runs exactly
 * when there are more matches than characters, which is exactly when every
 * character has already been spent. Its two-character branch is unreachable,
 * and the comment beside it reads the empty-prefix case as a corner rather than
 * as the whole branch. Ported faithfully, no pair would ever be issued.
 *
 * Holding characters back is what gives the branch something to do. With `A`
 * characters and `p` of them reserved as prefixes, the reach is
 * `(A - p)` singles plus `p * (A - 1)` pairs — a prefix may pair with any
 * character except itself, including one already used as a single label, since
 * only the FIRST character of a pair has to be unambiguous.
 *
 * Take the smallest `p` that reaches every match, so single-character labels
 * stay as plentiful as possible; where no `p` reaches them all, take the
 * smallest `p` among those with the greatest reach.
 *
 * **"The largest `p`" is the wrong fallback, and review caught it.** Reach
 * grows with `p` only while `A > 2`. At `A === 2` it is flat — one single plus
 * one pair, or two pairs, both reach exactly two — so spending everything on
 * prefixes throws away the one single-character label the highest-priority
 * match should have had, for nothing.
 */
function reach(available: number, prefixes: number): number {
  return available - prefixes + prefixes * (available - 1);
}

function planLabels(available: number, matches: number): LabelSplit {
  if (available === 0) return { singles: 0, prefixes: 0 };
  if (matches <= available) return { singles: matches, prefixes: 0 };
  // One character cannot prefix a pair — it has nothing to pair with.
  if (available < 2) return { singles: available, prefixes: 0 };

  let best = 1;
  for (let prefixes = 1; prefixes <= available; prefixes++) {
    if (reach(available, prefixes) >= matches) return { singles: available - prefixes, prefixes };
    if (reach(available, prefixes) > reach(available, best)) best = prefixes;
  }

  return { singles: available - best, prefixes: best };
}

/**
 * Hand a label to each match, in the priority order they arrive in.
 *
 * **A pair never starts with a character that is also a single label.** The Qt
 * source calls this rule critical and it is: a single-character label resolves
 * on the keystroke, so a pair sharing its first character could never be
 * reached. Matches past the pool's reach keep `""` and simply have no jump —
 * deliberate degradation, and with only visible rows labelled it is rare.
 */
function assignLabels(matches: readonly FlashMatch[], available: readonly string[]): FlashMatch[] {
  const { singles, prefixes } = planLabels(available.length, matches.length);
  const labelled = matches.map((match, position) => ({
    ...match,
    label: position < singles ? (available[position] ?? "") : "",
  }));

  let next = singles;
  for (const prefix of available.slice(singles, singles + prefixes)) {
    for (const second of available) {
      const target = labelled[next];
      if (target === undefined) return labelled;
      if (second === prefix) continue;
      labelled[next] = { ...target, label: prefix + second };
      next++;
    }
  }

  return labelled;
}

/**
 * Label every candidate whose name contains the query.
 *
 * `cursorIndex` positions the cursor within the CURRENT column and decides
 * nothing else; it is what makes the nearest row take the easiest key.
 *
 * The caller may hand over a query in any case — it is lowered here rather than
 * relied upon, since the Qt original documents "already lowercase" as a
 * precondition and one of its two callers is the one that lowers it.
 */
export function computeFlash(
  query: string,
  candidates: readonly FlashCandidate[],
  cursorIndex: number,
): FlashLabelling {
  const needle = query.toLowerCase();
  if (needle === "") return nothing();

  const found: FlashMatch[] = [];
  for (const candidate of candidates) {
    const matchStart = candidate.name.toLowerCase().indexOf(needle);
    if (matchStart !== -1) found.push({ ...candidate, label: "", matchStart });
  }
  if (found.length === 0) return nothing();

  const continuations = continuationChars(needle, found);
  const available = [...LABEL_CHARS].filter((char) => !continuations.has(char));
  const matches = assignLabels(byPriority(found, cursorIndex), available);

  const labelChars = new Set<string>();
  for (const match of matches) for (const char of match.label) labelChars.add(char);

  return { matches, continuations, labelChars };
}
