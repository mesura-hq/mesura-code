/**
 * The little of a Monaco model this cache needs.
 *
 * Declared here rather than imported so the cache can be tested against a fake:
 * the eviction rules are the part worth testing, and standing up real models
 * would test Monaco instead.
 */
export interface CachedModel {
  dispose(): void;
  isDisposed(): boolean;
  getValue(): string;
}

export interface ModelStore<Model extends CachedModel> {
  create(key: string, contents: string, languageId: string): Model;
}

export interface AcquiredModel<Model extends CachedModel> {
  readonly model: Model;
  /**
   * True when this model was already in the cache, with the user's undo stack,
   * selection and scroll position on it. The caller has to decide whether its
   * contents are still current; the cache does not know what is on disk.
   */
  readonly reused: boolean;
}

interface CacheEntry<Model extends CachedModel, ViewState> {
  readonly model: Model;
  viewState: ViewState | null;
  active: boolean;
}

/** How many files keep their undo history after the user moves off them. */
export const RETAINED_MODEL_LIMIT = 32;

/**
 * Keeps one Monaco model per file, so undo (which belongs to the model, not the editor) survives a
 * switch away and back. Bounded: `projects.readFile` truncates at a megabyte, and only
 * `RETAINED_MODEL_LIMIT` idle models are kept. The active model is never evicted.
 */
export class MonacoFileModelCache<Model extends CachedModel, ViewState> {
  readonly #store: ModelStore<Model>;
  readonly #limit: number;
  /**
   * Insertion-ordered, and re-inserted on every acquire. A `Map` iterates in
   * insertion order, which makes the first inactive key the least recently used
   * one without keeping a second structure in step with this one.
   */
  readonly #entries = new Map<string, CacheEntry<Model, ViewState>>();

  /**
   * Told when a key is dropped, so state keyed by the same path (the retention record) is dropped
   * with it instead of growing for the whole session.
   */
  #onEvict: ((key: string) => void) | null = null;

  constructor(store: ModelStore<Model>, limit: number = RETAINED_MODEL_LIMIT) {
    this.#store = store;
    this.#limit = limit;
  }

  onEvict(listener: (key: string) => void): void {
    this.#onEvict = listener;
  }

  /**
   * The model for a file, reused when one is held for it.
   *
   * A model Monaco disposed behind our back is treated as absent rather than
   * handed back, because every call on a disposed model throws.
   */
  acquire(key: string, contents: string, languageId: string): AcquiredModel<Model> {
    const existing = this.#entries.get(key);
    if (existing !== undefined && !existing.model.isDisposed()) {
      existing.active = true;
      this.#touch(key, existing);
      return { model: existing.model, reused: true };
    }
    if (existing !== undefined) this.#entries.delete(key);

    const model = this.#store.create(key, contents, languageId);
    this.#entries.set(key, { model, viewState: null, active: true });
    this.#evict();
    return { model, reused: false };
  }

  /** Marks a file as no longer on screen, which makes its model evictable. */
  release(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    entry.active = false;
    this.#evict();
  }

  /** Remembers where the caret and the scroll were when the user left a file. */
  saveViewState(key: string, viewState: ViewState | null): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    entry.viewState = viewState;
  }

  viewStateFor(key: string): ViewState | null {
    return this.#entries.get(key)?.viewState ?? null;
  }

  /** True when a model is held for this file, for tests and for assertions. */
  has(key: string): boolean {
    const entry = this.#entries.get(key);
    return entry !== undefined && !entry.model.isDisposed();
  }

  get size(): number {
    return this.#entries.size;
  }

  disposeAll(): void {
    for (const entry of this.#entries.values()) {
      if (!entry.model.isDisposed()) entry.model.dispose();
    }
    this.#entries.clear();
  }

  #touch(key: string, entry: CacheEntry<Model, ViewState>): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #evict(): void {
    if (this.#entries.size <= this.#limit) return;
    // The file on screen is never evicted, however long it has been open, so
    // the cache can sit one over its limit while a long-open file is active.
    const evictable: string[] = [];
    for (const [key, entry] of this.#entries) {
      if (!entry.active) evictable.push(key);
    }
    for (const key of evictable) {
      if (this.#entries.size <= this.#limit) return;
      const entry = this.#entries.get(key);
      if (entry === undefined) continue;
      if (!entry.model.isDisposed()) entry.model.dispose();
      this.#entries.delete(key);
      this.#onEvict?.(key);
    }
  }
}

/**
 * The cache key for one file, which is also the model's URI: Monaco throws on a second model for
 * one URI, so one string for both makes that collision impossible. The working directory is escaped
 * so its separators do not become URI path segments.
 */
export function monacoFileModelKey(
  environmentId: string,
  cwd: string,
  relativePath: string,
): string {
  return `mesura-file:///${environmentId}/${encodeURIComponent(cwd)}/${relativePath}`;
}

/**
 * The path back out of a model key.
 *
 * Beside the function that builds the key, so the two cannot drift. The `cwd`
 * is encoded on the way in precisely so it holds no separator, which is what
 * makes everything after it the file's own path however many segments it has.
 */
export function relativePathFromModelKey(key: string): string {
  const parts = key.split("/");
  return parts.slice(5).join("/");
}

/** The cache as the file panel and the surface pass it around. */
export type MonacoFileModels = MonacoFileModelCache<
  import("monaco-editor").editor.ITextModel,
  import("monaco-editor").editor.ICodeEditorViewState
>;
