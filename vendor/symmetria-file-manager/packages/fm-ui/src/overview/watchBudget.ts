import { OVERVIEW_LIMITS } from "./limits.ts";

/** Share capacity across retiring and replacement overview generations. */
class WatchBudget {
  private held = 0;
  private waiting = new Set<() => void>();
  async acquire(active: () => boolean): Promise<(() => void) | null> {
    while (active()) {
      if (this.held < OVERVIEW_LIMITS.directoryWatches) {
        this.held++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.held--;
          this.wake();
        };
      }
      await new Promise<void>((resolve) => this.waiting.add(resolve));
    }
    return null;
  }
  wake(): void {
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const resume of waiting) resume();
  }
}
export const overviewWatchBudget = new WatchBudget();
