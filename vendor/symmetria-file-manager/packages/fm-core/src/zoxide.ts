/**
 * Reading the frecent-directory list, and narrowing it.
 *
 * `zoxide` keeps a ranked record of the directories you actually go to. Asking
 * it costs a subprocess, so the list is fetched ONCE when the popup opens and
 * narrowed here as the user types — a query per keystroke would spawn a process
 * per character.
 */

export interface FrecentDirectory {
  /** zoxide's own ranking. Kept so a caller can show it. */
  readonly score: number;
  readonly path: string;
}

/**
 * Read what `zoxide query --list --score` printed.
 *
 * The format was measured rather than assumed, and it has two properties a
 * parser written from memory gets wrong:
 *
 * - **the score is right-aligned**, so every line but the widest begins with
 *   spaces;
 * - **a path may contain spaces**, so the split is on the FIRST run of
 *   whitespace only. Splitting on all of them truncates `My Documents` to `My`.
 *
 * A line that cannot be read is skipped rather than yielding a row with a NaN
 * score, which would sort unpredictably and render as nothing.
 *
 * The order is zoxide's own, which is by frecency. Re-sorting here would throw
 * away the one thing it knows that this application does not.
 */
export function parseFrecent(stdout: string): FrecentDirectory[] {
  const found: FrecentDirectory[] = [];

  for (const line of stdout.split("\n")) {
    const entry = readLine(line);
    if (entry !== null) found.push(entry);
  }

  return found;
}

function readLine(line: string): FrecentDirectory | null {
  const trimmed = line.trimStart();
  const gap = trimmed.search(/\s/);
  if (gap < 0) return null;

  const score = Number(trimmed.slice(0, gap));
  if (!Number.isFinite(score)) return null;

  // The rest of the line, with the separating whitespace removed from the
  // front and ONLY a carriage return from the end.
  //
  // Not `trimEnd()`. A directory whose name ends in a space is unusual and
  // entirely legal, and trimming would hand back a different path that most
  // likely does not exist — a wrong row rather than a skipped one, which is
  // the failure this parser is written to avoid.
  const path = trimmed.slice(gap).trimStart().replace(/\r$/, "");
  // Anything that is not an absolute path is not something this can navigate
  // to, and a relative one would resolve against whatever the pane happens to
  // be showing.
  return path.startsWith("/") ? { score, path } : null;
}

/**
 * Keep the entries whose path contains what was typed.
 *
 * A plain, case-insensitive substring match, deliberately. A subsequence match
 * would make `dtfl` find `.dotfiles`, which is what a fuzzy finder does — and
 * the fuzzy finder is a run of its own, designed together with Mesura Code. A
 * second half-built matcher living here is the first thing that run would have
 * to delete.
 */
export function filterFrecent(
  entries: readonly FrecentDirectory[],
  query: string,
): FrecentDirectory[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return [...entries];

  return entries.filter((entry) => entry.path.toLowerCase().includes(wanted));
}
