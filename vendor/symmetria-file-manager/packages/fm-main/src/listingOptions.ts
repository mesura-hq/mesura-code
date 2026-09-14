import { homedir } from "node:os";
import { join } from "node:path";

import {
  decodeListingOptions,
  type ListingOptions,
  type StoredListingOptions,
} from "@symmetria/fm-core/listingOptions";

import { readJsonObject, writeJsonObject } from "./jsonStore.ts";

/**
 * The listing order, on disk.
 *
 * `fm-core/listingOptions` decides what a stored order means; this owns where
 * it lives and what happens when the disk disagrees. Modelled on
 * `bookmarks.ts`, which solved the same problem — read that file for the
 * reasoning behind the three-way read and the write-then-rename.
 *
 * ── Its own file, not a key in the bookmark store ───────────────────────────
 * The two are written by different actions at different rates, and a sort
 * change must not put the bookmark file at risk. Unlike the bookmarks, this is
 * NOT shared with the Qt build — that one keeps its order elsewhere — so there
 * is no cross-build contract to honour here.
 */

export interface ListingLocation {
  readonly home: string;
  /** An explicit path, from `SYMMETRIA_FM_LISTING` or from a test. */
  readonly override?: string | undefined;
}

/** Where the file lives, beside the bookmarks. */
export function listingOptionsFilePath({ home, override }: ListingLocation): string {
  if (override !== undefined && override !== "") return override;
  return join(home, ".config", "symmetria-fm", "listing.json");
}

/**
 * The environment variable that relocates the file.
 *
 * Exists for the same two reasons `SYMMETRIA_FM_BOOKMARKS` does: a test must
 * never touch the operator's real configuration, and a user may want the file
 * somewhere else.
 */
const LISTING_PATH_ENV = "SYMMETRIA_FM_LISTING";

/** Where this process reads and writes, unless something says otherwise. */
export function defaultListingOptionsPath(): string {
  return listingOptionsFilePath({ home: homedir(), override: process.env[LISTING_PATH_ENV] });
}

/**
 * Read the file.
 *
 * Three answers, and the difference between the first two decides whether the
 * file may be written back at all — see `resolveListingOptions`. The reading
 * itself is `jsonStore.ts`'s, shared with the bookmark store.
 */
export async function loadListingOptions(path: string): Promise<StoredListingOptions> {
  const read = await readJsonObject(path);
  if (read.kind === "absent") return null;
  if (read.kind === "unreadable") return "unreadable";

  // Field by field: a file that got ONE field wrong keeps the others.
  return decodeListingOptions(read.value);
}

/** Write the file, atomically. See `jsonStore.ts` for why the rename matters. */
export async function saveListingOptions(path: string, options: ListingOptions): Promise<void> {
  await writeJsonObject(path, options);
}
