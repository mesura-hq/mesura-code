/**
 * Remembers, per file path, the text the editor last held for it.
 *
 * The record lives beside the models it describes, in the registry that holds
 * a project's editor state, and lasts exactly as long as they do — which is
 * longer than any panel, because opening Settings or another project unmounts
 * the panel and the undo stack has to survive that. It answers one question:
 * when a `contents` prop arrives for a path, did this editor produce that
 * text, or did something outside write it?
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
   * Called when the model cache beside this one evicts the same path, which is
   * what bounds this map. It has to be: the record lives as long as the
   * project rather than as long as a panel, so without this it would hold one
   * string per file ever opened for the whole session. The policy stays with
   * the cache, where a cap can be sized against real documents rather than
   * guessed at here — this only follows it.
   */
  forget(relativePath: string): void {
    this.#byPath.delete(relativePath);
  }

  clear(): void {
    this.#byPath.clear();
  }
}
