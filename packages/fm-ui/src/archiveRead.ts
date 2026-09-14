import {
  type ArchiveListing,
  buildArchiveListing,
} from "@symmetria/fm-core/preview/archive/listing";
import { readTarIndex, type TarLimits } from "@symmetria/fm-core/preview/archive/tar";
import type { ByteSource } from "@symmetria/fm-core/preview/archive/types";
import { readZipIndex } from "@symmetria/fm-core/preview/archive/zip";
import type { ArchiveCompression, ArchiveFormat } from "@symmetria/fm-core/preview/route";

/**
 * Fetching an archive and handing it to the reader that fits it.
 *
 * ── Separate from the worker that calls it, on purpose ──────────────────────
 * `archive.worker.ts` is a worker entry point: importing it runs
 * `self.addEventListener` and it cannot be reached from a test. Everything
 * worth testing lives here.
 *
 * ── Why the parsing happens in the renderer at all ──────────────────────────
 * The same argument `spreadsheetParse.ts` makes. An archive is untrusted input
 * that arrived from a browser download, and the renderer is sandboxed with no
 * filesystem while the main process has both. A parser compromise on this side
 * buys an attacker a wedged preview pane.
 *
 * ── Two formats, two completely different fetches ───────────────────────────
 * A zip is read by ADDRESS: two ranged requests for the tail and the index, so
 * a 1.5 GB archive costs kilobytes. A tar has no index and can only be WALKED,
 * so its body is streamed and discarded as it goes. That asymmetry is the whole
 * reason `fm-core` has two readers, and it reaches all the way out to here.
 */

export interface ArchiveContents {
  readonly kind: "listing";
  readonly listing: ArchiveListing;
  /**
   * The reader gave up before the end, so every count is a lower bound.
   *
   * Only a tar can be partial. A zip's index is complete or it is not read at
   * all. Distinct from `listing.truncated`, which says the ROWS were capped
   * while the counts are still exact.
   */
  readonly partial: boolean;
}

export type ReadArchive = ArchiveContents | { readonly kind: "unreadable" };

const UNREADABLE: ReadArchive = { kind: "unreadable" };

/** Bytes to a string. The renderer has a real one; `fm-core` does not. */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Random access to the previewed file, one HTTP range at a time.
 *
 * `size` comes from the directory scan rather than from a HEAD request, so
 * there is no probe round trip before the first real read.
 */
function rangedSource(url: string, size: number): ByteSource {
  return {
    size,
    decodeText,
    async read(start: number, length: number): Promise<Uint8Array> {
      const end = start + length - 1;
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      // A short or failed read is not an error here: `readZipIndex` treats
      // fewer bytes than it asked for as a truncated archive, which is what it
      // is, and answers a value rather than throwing.
      if (!response.ok) return new Uint8Array(0);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/**
 * A response body as an async iterable, cancelling it when the walk stops.
 *
 * Written by hand rather than relying on `ReadableStream` being async-iterable:
 * Chromium has it and happy-dom may not, and a pane that works only in the
 * browser cannot be tested. The cancel in the `finally` is the load-bearing
 * part — `readTarIndex` calls `close()` the moment it hits a bound, and without
 * this a huge tarball would keep decompressing after nobody wanted the answer.
 */
async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    // The stream may already be closed, and cancelling a closed stream throws.
    // Nothing here can act on that, and letting it escape would turn a
    // finished read into a failed one.
    try {
      await reader.cancel();
    } catch {
      // Already done with it.
    }
  }
}

async function readZip(url: string, size: number): Promise<ReadArchive> {
  const index = await readZipIndex(rangedSource(url, size));
  if (index.kind === "unreadable") return UNREADABLE;
  return { kind: "listing", listing: buildArchiveListing(index.entries), partial: false };
}

async function readTar(
  url: string,
  compression: ArchiveCompression,
  limits: TarLimits,
): Promise<ReadArchive> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) return UNREADABLE;

  // The walker knows nothing about compression, deliberately: it takes bytes,
  // and where those bytes came from is this module's problem.
  const stream =
    compression === "gzip"
      ? response.body.pipeThrough(new DecompressionStream("gzip"))
      : response.body;

  const index = await readTarIndex(chunksOf(stream), decodeText, limits);
  if (index.kind === "notAnArchive") return UNREADABLE;

  return {
    kind: "listing",
    listing: buildArchiveListing(index.entries),
    partial: index.stopped !== null,
  };
}

/**
 * List a previewed archive.
 *
 * Never throws. A corrupt, encrypted or hostile file is an ordinary thing to
 * land the cursor on, so every failure is a value the pane draws a notice from
 * — the worker's caller has no catch, and a throw there becomes an unhandled
 * rejection with an empty pane and no reason given.
 *
 * @param size the file's length, from the directory scan.
 * @param limits overridden only by tests, which cannot afford a real ceiling.
 */
export async function readArchive(
  url: string,
  format: ArchiveFormat,
  compression: ArchiveCompression,
  size: number,
  limits: TarLimits = {},
): Promise<ReadArchive> {
  try {
    return format === "zip" ? await readZip(url, size) : await readTar(url, compression, limits);
  } catch {
    // A failed fetch, or a gzip stream that turns out not to be one — the
    // decompressor rejects those, and neither reader can.
    return UNREADABLE;
  }
}
