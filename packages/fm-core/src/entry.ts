/** What a directory entry is, once. */
export type EntryKind = "file" | "directory" | "other";

/**
 * One directory entry, as an immutable snapshot.
 *
 * Immutable on purpose. The Qt version held a `QFileInfo` stat'd once at
 * construction and mutated nothing, which meant a file that changed on disk
 * kept its stale size until the entry was rebuilt. Keeping the snapshot but
 * rebuilding it on change — remove plus add, never mutate — is what makes a
 * growing file show its real size.
 */
export interface FsEntry {
  readonly name: string;
  readonly kind: EntryKind;
  readonly size: number;
  /** Milliseconds since the epoch. */
  readonly modifiedMs: number;
  /** True when the entry itself is a link, whatever it points at. */
  readonly isSymlink: boolean;
  /** A leading dot. Reported, never filtered here — the view decides. */
  readonly isHidden: boolean;
  /**
   * The entry could not be stat'd — permission denied, or it vanished between
   * the listing and the stat.
   *
   * Without this, a failure is indistinguishable from a legitimately empty file
   * dated 1970, and the pane shows a confident `0 B` for something it could not
   * read at all. Absent means readable.
   */
  readonly unreadable?: boolean;
}

/**
 * An entry reduced to the two facts a listing needs.
 *
 * The preview column draws a name and an icon, and the icon is chosen from the
 * name and the kind. Sending a whole `FsEntry` per row would carry a size, an
 * mtime and two flags that nothing there reads — across a process boundary,
 * hundreds of times, every time the cursor settles on a directory.
 */
export interface EntrySummary {
  readonly name: string;
  readonly kind: EntryKind;
}

/** What a preview would do with this entry. */
export type EntryClass = "image" | "text" | "binary";
