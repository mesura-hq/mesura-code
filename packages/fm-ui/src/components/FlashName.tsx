/**
 * One name during a flash session, with its label drawn into it.
 *
 * ── The label OVERTYPES the name, and that is the design ───────────────────
 * It replaces the characters that follow the match rather than sitting beside
 * them, so the key to press appears where the eye is already looking. The name
 * is briefly not the name; the session is short and the name comes back whole
 * the moment it ends. The Qt build draws it the same way, in
 * `FileListItem._highlightFlash`, and the operator chose this over a chip at
 * the row's edge when the two were put side by side.
 *
 * **One component, two callers.** The Qt build carries two divergent copies of
 * this function and its own documentation lists that as a defect awaiting
 * consolidation. The previewed directory's rows are not `FileRow` — deliberately,
 * since they have neither a cursor nor a mark — so the shared piece is this
 * rather than the row.
 */

/**
 * What one row needs in order to draw its label.
 *
 * NOT `FlashLabelling`, which is the engine's name for the whole result — the
 * matches, the continuations and the characters spent. One name for one thing:
 * the two were briefly both called that and the compiler caught it, which is
 * the cheap way to find out.
 */
export interface FlashRowLabel {
  /** What has been typed, so the matched characters can be marked. */
  readonly query: string;
  /** The keys that jump here. Never empty: an unlabelled match is not one. */
  readonly label: string;
  /** Where the query sits in the name. */
  readonly matchStart: number;
}

export function FlashName({
  name,
  flash,
}: {
  readonly name: string;
  readonly flash: FlashRowLabel | null;
}) {
  if (flash === null || flash.label === "" || flash.matchStart < 0) return <>{name}</>;

  const matchEnd = flash.matchStart + flash.query.length;
  // `Math.min` because a label may run past the end of a short name — "many"
  // labelled `s` on a match at 2 has one character left to overtype and needs
  // no second one.
  const rest = name.slice(Math.min(matchEnd + flash.label.length, name.length));

  return (
    <>
      {name.slice(0, flash.matchStart)}
      <span className="row__flash-query">{name.slice(flash.matchStart, matchEnd)}</span>
      <span className="row__flash-label">{flash.label}</span>
      {rest}
    </>
  );
}
