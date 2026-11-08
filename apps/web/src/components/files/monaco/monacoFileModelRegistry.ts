/**
 * Editor models held outside React so undo survives a route change (Settings, a thread in another
 * project), which no component survives. Bounded per project and by project count, but a project
 * still open is never let go: the bound holds only while fewer projects than the limit are open at
 * once. One file panel per chat view keeps that true; a two-project split view would break it.
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
