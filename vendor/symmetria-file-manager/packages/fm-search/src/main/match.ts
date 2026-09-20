/**
 * Where each character of the query sits in the name.
 *
 * The engine does not tell us. Its file-search result carries no per-character
 * positions — only its content search does — so the row renderer would have
 * nothing to highlight. The Qt build recomputes them the same way, with a
 * greedy subsequence match, and this is the port of that.
 *
 * **Greedy, and that is a deliberate approximation.** It takes the first
 * position that still matches, which is not always the run a human would call
 * the best one: for `stat.txt` against `st` it returns `[0, 1]` rather than the
 * arguably nicer `[0, 3]`. The engine already decided which rows match and in
 * what order; this only decides where to draw the emphasis, so an occasional
 * suboptimal span costs a little visual polish and nothing else. An optimal
 * span would cost a dynamic program per row, per keystroke.
 */
export function matchIndices(haystack: string, needle: string): readonly number[] {
  if (needle === "") return [];

  const name = haystack.toLowerCase();
  const query = needle.toLowerCase();
  const found: number[] = [];

  let at = 0;
  for (const character of query) {
    const hit = name.indexOf(character, at);
    // One character unplaceable makes the whole query a non-match. Returning
    // the partial run would draw emphasis on a row that does not match.
    if (hit === -1) return [];
    found.push(hit);
    at = hit + 1;
  }
  return found;
}
