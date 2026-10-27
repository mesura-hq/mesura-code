/**
 * The line a reveal request lands on. A stale link or search hit can name a line past the end, and
 * landing on the last line beats landing nowhere, so requests are clamped rather than ignored.
 */
export function resolveRevealLine(requestedLine: number, lineCount: number): number {
  // Monaco counts an empty document as one line; a caller computing its own
  // count may not, and a reveal of line 0 throws.
  const lastLine = Math.max(1, Math.floor(lineCount));
  const requested = Math.floor(requestedLine);
  return Math.min(Math.max(1, requested), lastLine);
}
