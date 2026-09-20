import { failure, type Result } from "@symmetria/fm-core/contract";
import type { OverviewReply } from "@symmetria/fm-core/overview/contract";
import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { isAncestorPath } from "@symmetria/fm-core/overview/model";
import { joinPath } from "@symmetria/fm-core/pane";
import { cancelOverview, readOverview } from "../bridge.ts";
import { OVERVIEW_LIMITS } from "./limits.ts";
import { OverviewSubscriptions } from "./subscriptions.ts";
export const EXCLUSIONS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "__pycache__",
] as const;
export interface OverviewSnapshot {
  readonly folders: ReadonlyMap<string, OverviewFolder>;
  readonly loading: boolean;
  readonly inspected: number;
  readonly coverage?: ReadonlyMap<string, string>;
}
interface Reservation {
  limit: number;
  growth: number;
}
interface Job {
  path: string;
  depth: number;
  refresh: boolean;
}
export function representedEntries(folders: ReadonlyMap<string, OverviewFolder>): number {
  let count = 0;
  for (const folder of folders.values()) count += folder.entries.length;
  return count;
}
let nextSession = 0;
/** Owns scan reservations, branch invalidations and watches for one visible generation. */
export class OverviewSession {
  readonly folders = new Map<string, OverviewFolder>();
  private queue: Job[] = [];
  private pending = new Map<string, Job>();
  private cancelled = new Set<string>();
  private dirty = new Set<string>();
  private coverage = new Map<string, string>();
  private inspected = 0;
  private reserved = 0;
  private reservedGrowth = 0;
  private reads = 0;
  private stopped = false;
  private serial = 0;
  private readonly id = `overview:${nextSession++}`;
  private readonly watches: OverviewSubscriptions;
  constructor(
    readonly root: string,
    private readonly showHidden: boolean,
    private readonly changed: (snapshot: OverviewSnapshot) => void,
    seed?: OverviewSnapshot,
    private readonly automaticDepth: number = OVERVIEW_LIMITS.automaticDepth,
  ) {
    for (const [path, folder] of seed?.folders ?? []) this.folders.set(path, folder);
    this.queue.push({ path: root, depth: 0, refresh: false });
    for (const folder of this.folders.values()) {
      if (folder.path !== root && canRevalidate(folder))
        this.queue.push({ path: folder.path, depth: folder.depth, refresh: false });
    }
    this.watches = new OverviewSubscriptions(
      this.id,
      (path) => this.invalidate(path),
      (path, error) => {
        if (error === null) this.coverage.delete(path);
        else this.coverage.set(path, error);
        this.publish();
      },
    );
  }
  start(): void {
    this.pump();
  }
  stop(): void {
    this.stopped = true;
    for (const id of this.pending.keys()) cancelOverview(id);
    this.watches.stop();
    this.pending.clear();
    this.queue = [];
    this.dirty.clear();
  }
  include(path: string): void {
    const folder = this.folders.get(path);
    if (!folder || folder.status === "Loaded" || this.busy(path)) return;
    this.queue.push({ path, depth: folder.depth, refresh: false });
    this.pump();
  }
  private busy(path: string): boolean {
    return (
      this.queue.some((job) => job.path === path) ||
      [...this.pending.values()].some((job) => job.path === path)
    );
  }
  private invalidate(path: string): void {
    const folder = this.folders.get(path);
    if (!folder || this.stopped) return;
    if (this.busy(path)) {
      this.dirty.add(path);
      return;
    }
    this.queue.push({ path, depth: folder.depth, refresh: true });
    this.pump();
  }
  private publish(): void {
    if (!this.stopped)
      this.changed({
        folders: new Map(this.folders),
        loading: this.pending.size > 0 || this.queue.length > 0,
        inspected: this.inspected,
        coverage: new Map(this.coverage),
      });
  }
  private limit(job: Job): number {
    if (!job.refresh && this.reads >= OVERVIEW_LIMITS.directoryReads) return 0;
    const available =
      5000 -
      representedEntries(this.folders) +
      (this.folders.get(job.path)?.entries.length ?? 0) -
      this.reservedGrowth;
    return Math.max(
      0,
      Math.min(1000, available, job.refresh ? 1000 : 5000 - this.inspected - this.reserved),
    );
  }
  private pump(): void {
    if (this.stopped) return;
    while (this.queue.length && this.pending.size < 4) {
      const job = this.queue.shift();
      if (!job) break;
      const limit = this.limit(job);
      if (limit === 0) {
        if (this.pending.size > 0) {
          this.queue.unshift(job);
          break;
        }
        this.markLimited(job);
        continue;
      }
      const id = `${this.id}:${this.serial++}`;
      const reservation = this.reserve(job, limit);
      this.pending.set(id, job);
      if (!this.folders.has(job.path))
        this.folders.set(job.path, {
          path: job.path,
          depth: job.depth,
          entries: [],
          status: "Loading",
        });
      void this.read(job, id, reservation);
    }
    this.publish();
  }
  private reserve(job: Job, limit: number): Reservation {
    const growth = Math.max(0, limit - (this.folders.get(job.path)?.entries.length ?? 0));
    this.reservedGrowth += growth;
    if (!job.refresh) {
      this.reserved += limit;
      this.reads++;
    }
    return { limit, growth };
  }
  private account(job: Job, reservation: Reservation, reply: Result<OverviewReply> | null): void {
    this.reservedGrowth -= reservation.growth;
    if (job.refresh) return;
    this.reserved -= reservation.limit;
    // Failed or canceled reads can hide partial work. Keep that work charged
    // before discarding obsolete replies, rather than refunding the budget.
    if (reply) this.inspected += reply.ok ? reply.value.inspected : reservation.limit;
  }
  private markLimited(job: Job): void {
    const previous = this.folders.get(job.path);
    this.folders.set(job.path, {
      path: job.path,
      depth: job.depth,
      entries: previous?.entries ?? [],
      status: "Traversal budget reached",
    });
  }
  private removeBranch(path: string): void {
    for (const child of this.folders.keys()) {
      if (!isAncestorPath(path, child)) continue;
      this.folders.delete(child);
      this.watches.remove(child);
      this.dirty.delete(child);
    }
    this.queue = this.queue.filter((job) => !isAncestorPath(path, job.path));
    for (const [id, job] of this.pending)
      if (isAncestorPath(path, job.path)) {
        this.cancelled.add(id);
        cancelOverview(id);
      }
  }
  private reconcileChildren(folder: OverviewFolder, recursive: boolean): void {
    const children = new Set(
      folder.entries
        .filter((entry) => entry.kind === "directory" && !entry.isSymlink)
        .map((entry) => joinPath(folder.path, entry.name)),
    );
    const old = [...this.folders.values()].filter(
      (child) => child.depth === folder.depth + 1 && isAncestorPath(folder.path, child.path),
    );
    for (const child of old) if (!children.has(child.path)) this.removeBranch(child.path);
    for (const entry of folder.entries) {
      const path = joinPath(folder.path, entry.name);
      if (!children.has(path) || this.folders.has(path)) continue;
      const depth = folder.depth + 1;
      const status = childStatus(entry.name, depth, recursive, this.automaticDepth);
      this.folders.set(path, { path, depth, entries: [], status });
      if (status === "Queued") this.queue.push({ path, depth, refresh: false });
    }
  }
  private async read(job: Job, id: string, reservation: Reservation): Promise<void> {
    await this.watches.ensure(job.path);
    if (this.stopped) return;
    const started = !this.cancelled.has(id);
    const reply = !started
      ? failure<OverviewReply>("cancelled", "Branch removed")
      : await readOverview(job.path, id, reservation.limit);
    if (this.stopped) return;
    this.pending.delete(id);
    this.account(job, reservation, started ? reply : null);
    if (this.cancelled.delete(id) || !this.folders.has(job.path)) {
      this.pump();
      return;
    }
    this.applyReply(job, reply);
    if (this.dirty.delete(job.path)) this.queue.push({ ...job, refresh: true });
    this.pump();
  }
  private applyReply(job: Job, reply: Result<OverviewReply>): void {
    if (reply.ok) {
      const entries = reply.value.entries
        .filter((entry) => this.showHidden || !entry.isHidden)
        .sort(
          (a, b) =>
            Number(b.kind === "directory") - Number(a.kind === "directory") ||
            a.name.localeCompare(b.name),
        );
      const folder = {
        path: job.path,
        depth: job.depth,
        entries,
        status: reply.value.truncated
          ? "Partial sorted subset — directory limit reached"
          : "Loaded",
      };
      this.folders.set(job.path, folder);
      this.reconcileChildren(folder, !job.refresh);
    } else {
      const previous = this.folders.get(job.path);
      this.folders.set(job.path, {
        path: job.path,
        depth: job.depth,
        entries: previous?.entries ?? [],
        status: `Unreadable: ${reply.error.message}`,
      });
      this.watches.remove(job.path);
    }
  }
}

function canRevalidate(folder: OverviewFolder): boolean {
  return (
    folder.status === "Loaded" ||
    folder.status.startsWith("Partial") ||
    folder.status === "Queued" ||
    folder.status === "Loading" ||
    folder.status.startsWith("Unreadable") ||
    (folder.status === "Traversal budget reached" && folder.entries.length > 0)
  );
}
function childStatus(
  name: string,
  depth: number,
  recursive: boolean,
  automaticDepth: number,
): string {
  if (EXCLUSIONS.some((excluded) => excluded === name)) return "Excluded by scope";
  if (depth >= automaticDepth) return "Depth limit reached";
  return recursive ? "Queued" : "Not loaded";
}
