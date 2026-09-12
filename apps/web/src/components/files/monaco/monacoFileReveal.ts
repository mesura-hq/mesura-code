/**
 * The line a reveal request should actually land on.
 *
 * A request can name a line the file does not have: a link written against an
 * older revision, or a search hit in a file an agent has since shortened.
 * Landing on the last line is better than landing nowhere, so requests are
 * clamped rather than ignored.
 */
export function resolveRevealLine(requestedLine: number, lineCount: number): number {
  // Monaco counts an empty document as one line; a caller computing its own
  // count may not, and a reveal of line 0 throws.
  const lastLine = Math.max(1, Math.floor(lineCount));
  const requested = Math.floor(requestedLine);
  return Math.min(Math.max(1, requested), lastLine);
}
