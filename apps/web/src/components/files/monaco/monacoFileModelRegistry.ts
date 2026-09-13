/**
 * The editor state that has to outlive a route.
 *
 * A file's undo stack lives in its Monaco model, so whoever owns the model
 * owns the undo stack. The panel that owned it unmounts for three ordinary
 * things — opening Settings, switching to a thread in another project, and the
 * spinner shown while a file is read — and a developer who types, opens
 * Settings and comes back expects `Ctrl+Z` to still mean something.
 *
 * The cache was already hoisted once, from the surface to the panel, to
 * survive the spinner. This hoists it once more, out of React entirely,
 * because the other two are route changes and no component survives a route.
 * A module-level holder is the app's own pattern for that — the right panel,
 * the thread selection and the theme editor all keep their state this way —
 * and it costs no edit to the root route or to the chat view, which are two of
 * the files upstream changes most.
 *
 * Bounded twice over: the cache inside each project keeps a fixed number of
 * models, and this keeps a fixed number of projects. A project somebody still
 * has open is never one of the ones let go — which means the bound holds only
 * while the number of projects open at one moment stays under the limit. It
 * does today, because the chat view draws one file panel for one project; a
 * split view showing two projects at once would need this to say what it does
 * when every entry is in use.
 */

/** How many projects keep their models while nobody is looking at them. */
export const RETAINED_PROJECT_LIMIT = 4;

export interface MonacoFileModelRegistryOptions<Project> {
  /** Builds a project's models and retention, the first time it is asked for. */
  readonly create: (projectKey: string) => Project;
  /** Throws a project's models away, once it has been let go of long enough. */
  readonly dispose: (project: Project) => void;
  /**
   * A monotonic number, not a date.
   *
   * Only the order of the releases matters, and a clock makes a test wait for
   * one. Taking it as an argument is what lets the test drive the eviction
   * order directly instead of hoping.
   */
  readonly now: () => number;
}

interface Entry<Project> {
  readonly project: Project;
  /** How many panels currently have this project open. */
  mounted: number;
  releasedAt: number;
}

export class MonacoFileModelRegistry<Project> {
  readonly #entries = new Map<string, Entry<Project>>();
  readonly #options: MonacoFileModelRegistryOptions<Project>;

  constructor(options: MonacoFileModelRegistryOptions<Project>) {
    this.#options = options;
  }

  acquire(projectKey: string): Project {
    const existing = this.#entries.get(projectKey);
    if (existing !== undefined) {
      existing.mounted += 1;
      return existing.project;
    }
    const project = this.#options.create(projectKey);
    this.#entries.set(projectKey, { project, mounted: 1, releasedAt: this.#options.now() });
    this.#evict();
    return project;
  }

  release(projectKey: string): void {
    const entry = this.#entries.get(projectKey);
    if (entry === undefined) return;
    // Counted rather than assumed to be one. Two panels on one project is
    // reachable, and the first to unmount must not take the models out from
    // under the second.
    entry.mounted = Math.max(0, entry.mounted - 1);
    if (entry.mounted > 0) return;
    entry.releasedAt = this.#options.now();
    this.#evict();
  }

  #evict(): void {
    const candidates = [...this.#entries.entries()]
      .filter(([, entry]) => entry.mounted === 0)
      .sort(([, left], [, right]) => left.releasedAt - right.releasedAt);

    // Only the ones nobody is looking at can go, so the count that matters is
    // the whole map: a developer with four projects open keeps all four, and
    // the fifth is simply not retained once they leave it.
    let over = this.#entries.size - RETAINED_PROJECT_LIMIT;
    for (const [key, entry] of candidates) {
      if (over <= 0) break;
      this.#entries.delete(key);
      this.#options.dispose(entry.project);
      over -= 1;
    }
  }
}
