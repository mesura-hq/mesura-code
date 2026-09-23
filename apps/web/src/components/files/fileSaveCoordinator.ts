import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  /** The write that is in flight, so `flush` can wait for it rather than skip. */
  private persisting: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  /**
   * Writes what is pending now, rather than when the debounce runs out.
   *
   * `:w` in Neovim is the developer saying "now". Returns once the write has
   * been attempted, so a caller can report the result rather than guess at it.
   */
  async flush(): Promise<void> {
    this.clearTimer();
    // A write already in flight is not this one, and `persistLatest` declines
    // while one is running. Waiting for it and then writing what is pending is
    // what "now" means; without the wait, `:w` during a debounced save returns
    // having written nothing and the newest text goes out on the old timer.
    if (this.persisting !== null) await this.persisting;
    this.clearTimer();
    await this.persistLatest();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === this.confirmedRevision) return;

    this.saving = true;
    const running = this.runPersist();
    this.persisting = running;
    try {
      await running;
    } finally {
      this.persisting = null;
    }
  }

  private async runPersist(): Promise<void> {
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    const succeeded = result._tag === "Success";
    if (succeeded) {
      this.confirmedRevision = revision;
      this.options.onConfirmed(contents);
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (succeeded) this.options.onPendingChange(false);
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }
}
