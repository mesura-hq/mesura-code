import type { Bookmark } from "@symmetria/fm-core/bookmarks";
import { groupFor } from "@symmetria/fm-core/keys/chords";

export interface WhichKeyOverlayProps {
  /** The pending chord prefix. Nothing renders when it is empty. */
  readonly prefix: string;
  readonly cursorIsImage: boolean;
  /** What is bound, so the `g` menu lists real destinations. */
  readonly bookmarks: ReadonlyMap<string, Bookmark>;
}

/**
 * What the pending chord can resolve to.
 *
 * Reads the same chord table as the help sheet — one description, two readers.
 * It appears the moment a prefix is set and disappears when the chord resolves,
 * because there is no chord timeout to wait out.
 */
export function WhichKeyOverlay({ prefix, cursorIsImage, bookmarks }: WhichKeyOverlayProps) {
  if (prefix === "") return null;

  const group = groupFor(prefix, cursorIsImage, bookmarks);
  if (group === undefined) return null;

  return (
    <div className="which-key" data-testid="which-key">
      <span className="which-key__label">
        <kbd>{prefix}</kbd> {group.label}
      </span>
      {group.binds.map((entry) => (
        <span key={entry.key} className="which-key__row" data-testid="which-key-row">
          <kbd>{entry.key}</kbd>
          {entry.label}
        </span>
      ))}
    </div>
  );
}
