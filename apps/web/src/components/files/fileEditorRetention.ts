/**
 * Remembers, per file path, which document the editor last held for it.
 *
 * The file panel destroys and rebuilds its surface component on every file
 * switch, so nothing inside that component can remember the previous file.
 * This record lives above it, for as long as the panel does, and answers one
 * question: when the user comes back to a path, may the editor hand back the
 * document it already had — with its undo stack — or must it load fresh?
 *
 * It holds no editor type on purpose. The Pierre surface uses it today and the
 * Monaco surface uses the same instance later, so it stays a plain map.
 */
interface RetainedEditorFile {
  /**
   * The key the editor filed the document under. Absent until the editor
   * adopts the file. Kept as a plain optional rather than `string | undefined`
   * on purpose: the wider form would propagate into the shape
   * `projectFileEditorCacheKey` accepts, which lives in an upstream file this
   * fork merges every week. Callers omit the field instead of setting it
   * undefined.
   */
  readonly cacheKey?: string;
  /** The contents the editor last reported for this path. */
  readonly contents: string;
}

export class FileEditorRetention {
  readonly #byPath = new Map<string, RetainedEditorFile>();

  noteEditorFile(relativePath: string, file: RetainedEditorFile): void {
    this.#byPath.set(relativePath, file);
  }

  identityFor(relativePath: string): RetainedEditorFile | undefined {
    return this.#byPath.get(relativePath);
  }

  /**
   * True only when the retained document still describes the file on disk.
   *
   * A differing `queryContents` means something outside the editor rewrote the
   * file — an agent turn, a git operation — and the retained document is stale.
   * Reusing it there would show the user old text, so the answer is no and the
   * caller loads fresh. A retained entry with no `cacheKey` cannot be handed
   * back either, because there is no document filed under it yet.
   */
  canReuse(relativePath: string, queryContents: string): boolean {
    const retained = this.#byPath.get(relativePath);
    if (!retained?.cacheKey) return false;
    return retained.contents === queryContents;
  }

  /**
   * Drops one path's record.
   *
   * Nothing calls this yet, and that is deliberate rather than an oversight:
   * the map holds one string per file opened and is released whole when the
   * panel unmounts, so its growth is bounded by one panel's lifetime. The
   * eviction policy belongs with the editor model cache that replaces this
   * surface, which is where a cap can be sized against real documents instead
   * of guessed at here.
   */
  forget(relativePath: string): void {
    this.#byPath.delete(relativePath);
  }

  clear(): void {
    this.#byPath.clear();
  }
}
