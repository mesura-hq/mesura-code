/**
 * Per path, the text the editor last held; it lives with the project's models so undo survives a panel
 * unmount. Our own saved text coming back must not be re-applied (it moves the caret). Outside text
 * (an agent turn, git) must be applied as an edit. No editor type, so an editor swap does not reach it.
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

  /** False when something outside the editor rewrote the file, so the caller loads fresh text. */
  canReuse(relativePath: string, queryContents: string): boolean {
    const retained = this.#byPath.get(relativePath);
    if (retained === undefined) return false;
    return retained.contents === queryContents;
  }

  /**
   * The model cache calls this when it evicts the same path; that is the only bound on this map,
   * which otherwise keeps one string per file opened in the session. The cap belongs to the cache.
   */
  forget(relativePath: string): void {
    this.#byPath.delete(relativePath);
  }

  clear(): void {
    this.#byPath.clear();
  }
}
