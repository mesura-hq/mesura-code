import { watchDirectory } from "../bridge.ts";
import { OVERVIEW_LIMITS } from "./limits.ts";
import { overviewWatchBudget } from "./watchBudget.ts";

interface Slot {
  stop: () => Promise<void>;
  ready: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  retried: boolean;
}
/** Reserve capacity through asynchronous setup and acknowledged teardown. */
export class OverviewSubscriptions {
  private slots = new Map<string, Slot>();
  private stopped = false;
  private serial = 0;
  constructor(
    private readonly id: string,
    private readonly changed: (path: string) => void,
    private readonly coverage: (path: string, error: string | null) => void,
  ) {}
  ensure(path: string): Promise<void> {
    const existing = this.slots.get(path);
    if (existing) return existing.ready;
    if (this.stopped) return Promise.resolve();
    if (this.slots.size >= OVERVIEW_LIMITS.directoryWatches) {
      this.coverage(path, "Watch limit reached");
      return Promise.resolve();
    }
    const slot: Slot = {
      stop: async () => undefined,
      ready: Promise.resolve(),
      timer: null,
      retried: false,
    };
    this.slots.set(path, slot);
    slot.ready = this.arm(path, slot);
    return slot.ready;
  }
  private current(path: string, slot: Slot): boolean {
    return !this.stopped && this.slots.get(path) === slot;
  }
  private async arm(path: string, slot: Slot): Promise<void> {
    const release = await overviewWatchBudget.acquire(() => this.current(path, slot));
    if (!release) return;
    if (!this.current(path, slot)) {
      release();
      return;
    }
    let failed = false;
    const stop = await watchDirectory(path, `${this.id}:${this.serial++}:${path}`, (event) => {
      if (!this.current(path, slot)) return;
      if (event.error !== undefined) {
        failed = true;
        this.failed(path, slot, event.error);
        return;
      }
      slot.timer ??= setTimeout(() => {
        slot.timer = null;
        this.changed(path);
      }, 100);
    });
    let retired: Promise<void> | undefined;
    const retire = () => (retired ??= stop().finally(release));
    if (!this.current(path, slot)) await retire();
    else {
      slot.stop = retire;
      if (failed) await retire();
      else this.coverage(path, null);
    }
  }
  private failed(path: string, slot: Slot, error: string): void {
    this.coverage(path, error);
    void slot.stop();
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    if (slot.retried) return;
    slot.retried = true;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      slot.ready = this.rearm(path, slot);
    }, 500);
  }
  private async rearm(path: string, slot: Slot): Promise<void> {
    await slot.stop();
    if (!this.current(path, slot)) return;
    await this.arm(path, slot);
    if (this.current(path, slot)) this.changed(path);
  }
  remove(path: string): void {
    const slot = this.slots.get(path);
    if (!slot) return;
    this.slots.delete(path);
    if (slot.timer !== null) clearTimeout(slot.timer);
    void slot.stop();
    overviewWatchBudget.wake();
    this.coverage(path, null);
  }
  stop(): void {
    this.stopped = true;
    for (const path of this.slots.keys()) this.remove(path);
  }
}
