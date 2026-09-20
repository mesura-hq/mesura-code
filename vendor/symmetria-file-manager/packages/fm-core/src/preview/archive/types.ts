/**
 * What an archive reader is handed, and what every reader hands back.
 *
 * ── Why the capabilities are parameters ─────────────────────────────────────
 * This package compiles with `lib: ["ES2023"]` and `types: []` — read
 * `packages/fm-core/tsconfig.json`, which says why. So it has no `fetch` to
 * read bytes with, and no `TextDecoder` to turn a name into a string with.
 * Those two absences are what decide this file's shape. The tsconfig `include`
 * covers `test` as well, so the tests have neither one either.
 *
 * Passing both in is the same move `windowUrl.ts` made when it could not have
 * `URLSearchParams`. The alternative was a hand-rolled UTF-8 decoder, which is
 * a security-adjacent thing to write in passing: an overlong encoding accepted
 * here becomes a path that renders as one thing and means another.
 *
 * The panel supplies a ranged `fetch` and a real `TextDecoder`; the tests
 * supply an in-memory buffer and `String.fromCharCode`.
 */

/** Random access to an archive, however the caller obtains it. */
export interface ByteSource {
  /** The whole archive's length. A zip is read backwards from it. */
  readonly size: number;
  /**
   * `length` bytes from `start`. Shorter than asked for at the end of the
   * archive; never longer.
   */
  read(start: number, length: number): Promise<Uint8Array>;
  /** Bytes to a string. UTF-8 in the panel; ASCII in the tests. */
  decodeText(bytes: Uint8Array): string;
}

/**
 * One member of an archive, as the preview needs it.
 *
 * The path is whole and relative to the archive's root, exactly as the archive
 * stores it — `game/cache/build_info.json`, not `build_info.json` with a depth
 * beside it. Turning that into a tree is `listing.ts`'s job, and keeping it out
 * of here is what lets the zip and tar readers share one shape.
 *
 * There is deliberately **no modification time**. Neither the Qt build's
 * archive rows nor this one's show a date per member, so a field nothing reads
 * would be dead weight the dead-code gate is right to object to.
 */
export interface ArchiveEntry {
  readonly path: string;
  /** Uncompressed bytes. Always 0 for a directory. */
  readonly size: number;
  readonly isDirectory: boolean;
}

/**
 * The most rows an archive preview will show.
 *
 * 5000, matching `MaxEntries` in the Qt build's
 * `plugin/src/Symmetria/FileManager/Models/archivepreviewmodel.hpp`, so the two
 * builds truncate the same archive at the same place while both are installed.
 *
 * **The two readers treat it differently, and that asymmetry is deliberate.**
 * The tar walker stops AT this number, because walking is unbounded work and
 * every entry past the cap costs a read nobody will look at. The zip reader
 * does not cap at all: its index is already in hand by the time the first entry
 * is parsed, so stopping early would save nothing and would throw away the
 * total counts the pane needs in order to say how much it is not showing.
 * An earlier version of this comment claimed both readers shared the cap. They
 * do not, and `zip.ts` has never imported this constant.
 */
export const MAX_ARCHIVE_ENTRIES = 5000;
