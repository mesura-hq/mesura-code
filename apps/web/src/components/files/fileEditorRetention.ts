/**
 * Remembers, per file path, the text the editor last held for it.
 *
 * The record lives above the editing surface, for as long as the file panel
 * does, and answers one question: when a `contents` prop arrives for a path,
 * did this editor produce that text, or did something outside write it?
 *
 * The distinction is the whole point. Our own text coming back — a save the
 * server confirmed — must not be re-applied to the model, because rewriting a
 * document with what it already says moves the caret for nothing. Text from an
 * agent turn or a git operation must be applied, and must be applied as an edit
 * so the undo stack survives it.
 *
 * It holds no editor type on purpose, so an editor swap does not reach it.
 */
interface RetainedEditorFile {
  /** The contents the editor last reported for this path. */
  readonly contents: string;
}

export class FileEditorRetention {
  readonly #byPath = new Map<string, RetainedEditorFile>();

  noteEditorFile(relativePath: string, file: RetainedEditorFile): void {
    this.#byPath.set(relativePath, file);
  }

  /**
   * True only when the retained document still describes the file on disk.
   *
   * A differing `queryContents` means something outside the editor rewrote the
   * file — an agent turn, a git operation — and the retained document is stale.
   * Reusing it there would show the user old text, so the answer is no and the
   * caller loads fresh.
   */
  canReuse(relativePath: string, queryContents: string): boolean {
    const retained = this.#byPath.get(relativePath);
    if (retained === undefined) return false;
    return retained.contents === queryContents;
  }

  /**
   * Drops one path's record.
   *
   * Nothing calls this yet, and that is deliberate rather than an oversight:
   * the map holds one string per file opened and is released whole when the
   * panel unmounts, so its growth is bounded by one panel's lifetime. The
   * eviction policy belongs with the Monaco model cache, which is where a cap
   * can be sized against real documents instead of guessed at here.
   */
  forget(relativePath: string): void {
    this.#byPath.delete(relativePath);
  }

  clear(): void {
    this.#byPath.clear();
  }
}
