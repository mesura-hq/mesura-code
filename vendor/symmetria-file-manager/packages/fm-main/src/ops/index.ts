import { shell } from "electron";

import { createEntry, renameEntry, type TransferOutcome, transfer } from "./mutate.ts";
import { openEntry } from "./open.ts";

/**
 * The file operations, as one surface.
 *
 * Registration lives with the rest of the IPC; this is what it registers, so a
 * test can drive every operation without a window and without Electron's
 * transport.
 *
 * **Trash stays delegated, deliberately.** Electron's `shell.trashItem`
 * implements the freedesktop trash specification — the `.Trash` directory, the
 * `.trashinfo` record that makes a restore possible, the per-mount fallback.
 * Reimplementing it is a way to lose files, and a "trash" that cannot be
 * restored from is a delete with a friendlier name.
 */

/** Transfers that can still be cancelled, by the id the caller gave. */
const running = new Map<string, AbortController>();

interface TransferArguments {
  readonly sources: readonly string[];
  readonly destination: string;
  readonly mode: "copy" | "move";
  readonly overwrite: boolean;
  readonly transferId: string;
}

export interface Operations {
  transfer(
    args: TransferArguments,
    onProgress: (done: number, total: number) => void,
  ): Promise<TransferOutcome>;
  cancelTransfer(transferId: string): void;
  create(path: string, kind: "file" | "directory"): Promise<void>;
  rename(path: string, name: string): Promise<string>;
  trash(paths: readonly string[]): Promise<number>;
  open(path: string): Promise<"terminal" | "desktop">;
}

export const operations: Operations = {
  async transfer(args, onProgress) {
    // One controller per id. A caller reusing an id while its transfer is still
    // running would otherwise be unable to cancel either of them.
    const controller = new AbortController();
    running.set(args.transferId, controller);

    try {
      return await transfer({
        sources: args.sources,
        destination: args.destination,
        mode: args.mode,
        overwrite: args.overwrite,
        signal: controller.signal,
        onProgress,
      });
    } finally {
      running.delete(args.transferId);
    }
  },

  cancelTransfer(transferId) {
    running.get(transferId)?.abort();
  },

  create: createEntry,
  rename: renameEntry,

  async trash(paths) {
    let trashed = 0;
    for (const path of paths) {
      await shell.trashItem(path);
      trashed += 1;
    }
    return trashed;
  },

  open: openEntry,
};
