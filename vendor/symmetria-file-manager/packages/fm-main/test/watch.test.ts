import { type FSWatcher, type WatchListener, watch } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchDirectory } from "../src/fs/watch.ts";

let root: string;
let stop: (() => Promise<void>) | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "symfm-watch-"));
});

afterEach(async () => {
  await stop?.();
  stop = null;
  await rm(root, { recursive: true, force: true });
});

/** Wait for the first change event that satisfies `match`, or time out. */
function nextChange(
  events: { name: string; size: number; kind?: string }[][],
  match: (e: { name: string; size: number; kind?: string }) => boolean,
  timeoutMs = 8000,
): Promise<{ name: string; size: number; kind?: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      for (const batch of events) {
        const hit = batch.find(match);
        if (hit) {
          clearInterval(tick);
          resolve(hit);
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`no matching change within ${timeoutMs} ms`));
      }
    }, 25);
  });
}

describe("watchDirectory", () => {
  it("reports a file that grows after the initial listing, with its new size", async () => {
    // The regression this exists for. Qt's directory watcher omits IN_MODIFY,
    // so a file that grows on disk after it was first listed emitted no event
    // at all — a download streamed straight to its final name sat at 0 bytes
    // with no preview until the user navigated away and back. libuv's watches
    // include IN_MODIFY, so the per-file watch machinery the C++ carried
    // (syncFileWatches, kMaxFileWatches, the debounced rescan) is deleted
    // rather than ported. This test is what proves the deletion was safe.
    const target = join(root, "download.bin");
    await writeFile(target, "start");

    const batches: { name: string; size: number }[][] = [];
    stop = await watchDirectory(root, (changed) => batches.push(changed));

    await appendFile(target, "x".repeat(4096));

    const hit = await nextChange(batches, (e) => e.name === "download.bin" && e.size > 5);
    expect(hit.size).toBe(5 + 4096);
  });

  it("reports a newly created file", async () => {
    const batches: { name: string; size: number }[][] = [];
    stop = await watchDirectory(root, (changed) => batches.push(changed));

    await writeFile(join(root, "fresh.txt"), "hello");

    const hit = await nextChange(batches, (e) => e.name === "fresh.txt");
    expect(hit.size).toBe(5);
  });

  it("stops delivering once it is stopped", async () => {
    const batches: { name: string; size: number }[][] = [];
    const halt = await watchDirectory(root, (changed) => batches.push(changed));
    await halt();
    stop = null;

    await writeFile(join(root, "after.txt"), "ignored");
    await new Promise((r) => setTimeout(r, 500));

    expect(batches.flat().some((e) => e.name === "after.txt")).toBe(false);
  });

  it("reports a deletion as a deletion, not as an empty file", async () => {
    // Without a `kind`, a deleted file and a genuinely empty one are the same
    // event: both carry size 0. A consumer could not tell "drop this row" from
    // "this row is empty".
    const doomed = join(root, "doomed.txt");
    await writeFile(doomed, "bye");

    const batches: { name: string; size: number; kind: string }[][] = [];
    stop = await watchDirectory(root, (changed) => batches.push(changed));

    await rm(doomed);

    const hit = await nextChange(batches, (e) => e.name === "doomed.txt" && e.kind === "deleted");
    expect(hit.kind).toBe("deleted");
  });

  it("delivers nothing after stop, even for work already in flight", async () => {
    // The race the review found: a handler that started before `stop()` and
    // settled after it would still call back into a watcher its owner believes
    // is dead — delivering an update to a closed tab.
    const batches: unknown[][] = [];
    const halt = await watchDirectory(root, (changed) => batches.push(changed));

    await writeFile(join(root, "racing.txt"), "x");
    await halt();
    stop = null;

    const seen = batches.flat().length;
    await new Promise((r) => setTimeout(r, 600));
    expect(batches.flat().length).toBe(seen);
  });

  it("watches a directory reached through a symlink", async () => {
    // The watcher reports realpath-resolved paths. Comparing them against the
    // caller's raw string dropped every event in silence.
    const linked = join(root, "..", `${basename(root)}-link`);
    await symlink(root, linked);

    const batches: { name: string; size: number }[][] = [];
    const halt = await watchDirectory(linked, (changed) => batches.push(changed));

    await writeFile(join(root, "through-link.txt"), "hello");
    const hit = await nextChange(batches, (e) => e.name === "through-link.txt");
    expect(hit.size).toBe(5);

    await halt();
    await rm(linked, { force: true });
  });

  it("does not descend into subdirectories", async () => {
    // The regression this pins, and why it looks like a missing feature rather
    // than a fix. The first implementation used `@parcel/watcher` with a
    // comment claiming it was non-recursive. It is not, and it has no
    // non-recursive mode — `subscribe()` always walks the whole subtree, and
    // filtering the resulting EVENTS by directory made it look correct while
    // the watch itself still descended. Opening a pane on a home directory
    // failed with `inotify_add_watch ... No space left on device`: one pane
    // exhausted the kernel's per-user watch limit at startup.
    //
    // Miller columns show one directory at a time, so watching a subtree buys
    // nothing. Do NOT "fix" this test by making the watch recursive.
    const nested = join(root, "nested");
    await mkdir(nested);

    const batches: { name: string; size: number }[][] = [];
    stop = await watchDirectory(root, (changed) => batches.push(changed));

    await writeFile(join(nested, "deep.txt"), "hello");
    await new Promise((r) => setTimeout(r, 500));

    expect(batches.flat().some((e) => e.name === "deep.txt")).toBe(false);
  });

  it("releases its watch, so a tab that closes leaks nothing", async () => {
    // An inotify budget exhausted by abandoned watches is a defect that only
    // shows up after an hour of use, which is why it is pinned here.
    const halt = await watchDirectory(root, () => {});
    await expect(halt()).resolves.not.toThrow();
    await expect(halt()).resolves.not.toThrow();
    stop = null;
  });
});

it("reports unnamed invalidation and lost runtime coverage", async () => {
  let watcher: FSWatcher | undefined;
  const createWatcher = (
    path: string,
    options: { recursive: false },
    listener: WatchListener<string>,
  ) => {
    watcher = watch(path, options, listener);
    return watcher;
  };
  const changed = vi.fn();
  const error = vi.fn();
  stop = await watchDirectory(root, changed, error, createWatcher);
  if (!watcher) throw new Error("No watcher");
  watcher.emit("change", "rename", null);
  expect(changed).toHaveBeenCalledWith([]);
  watcher.emit("error", new Error("coverage lost"));
  expect(error).toHaveBeenCalledWith("coverage lost");
  changed.mockClear();
  watcher.emit("change", "rename", "late.txt");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(changed).not.toHaveBeenCalled();
});
