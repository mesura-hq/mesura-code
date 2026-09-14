import type { ArchiveListing } from "@symmetria/fm-core/preview/archive/listing";
import type { ArchiveCompression, ArchiveFormat } from "@symmetria/fm-core/preview/route";

import { readArchive } from "./archiveRead.ts";

/**
 * An archive, listed off the interface thread.
 *
 * Fifth worker in this package and the same discipline as the others: a
 * request carries an id, the answer carries it back, and the consumer drops any
 * answer whose id is not the current one. A preview is debounced by 150 ms and
 * the cursor keeps moving, so a late answer for the previous file is the normal
 * case rather than the corner.
 *
 * Everything worth testing lives in `archiveRead.ts`, because importing THIS
 * file runs the listener below and cannot be done from a test.
 */

export interface ArchiveRequest {
  readonly id: number;
  /** The token URL the main process issued for this file. */
  readonly url: string;
  readonly format: ArchiveFormat;
  readonly compression: ArchiveCompression;
  /** The file's length, from the directory scan. A zip is read backwards from it. */
  readonly size: number;
}

export type ArchiveResponse =
  | {
      readonly id: number;
      readonly kind: "listing";
      readonly listing: ArchiveListing;
      readonly partial: boolean;
    }
  /** Corrupt, encrypted, a gzip that is not a tar, or a fetch that failed. */
  | { readonly id: number; readonly kind: "unreadable" };

self.addEventListener("message", (event: MessageEvent<ArchiveRequest>) => {
  const request = event.data;

  void readArchive(request.url, request.format, request.compression, request.size).then((read) => {
    const answer: ArchiveResponse =
      read.kind === "unreadable"
        ? { id: request.id, kind: "unreadable" }
        : { id: request.id, kind: "listing", listing: read.listing, partial: read.partial };

    // Nothing to transfer: the rows are strings and numbers, which the
    // structured clone copies either way, and the list is capped at 5000.
    self.postMessage(answer);
  });
});
