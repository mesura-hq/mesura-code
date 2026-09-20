import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

import { readArchive } from "../src/archiveRead.ts";

/**
 * Fetching an archive and handing it to the reader.
 *
 * The readers themselves are covered exhaustively in `fm-core` against real
 * archives. What is left here is the part only this package does: asking for
 * byte ranges, piping a gzip through `DecompressionStream`, and turning every
 * failure into a value the pane can draw a notice from.
 *
 * ── The zip fixture is a real one ───────────────────────────────────────────
 * An `.xlsx` IS a zip, and this package already depends on a library that
 * writes them. So the zip under test is produced by a real writer rather than
 * assembled by hand — which is the one thing `fm-core`'s own tests cannot do.
 */

const URL_UNDER_TEST = "symmetria-fm://app/__preview/t";
const BLOCK = 512;

/** A real zip, written by SheetJS. */
function realZip(): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["a", 1]]), "Sheet1");
  const written: ArrayBuffer = XLSX.write(book, { type: "array", bookType: "xlsx" });
  return new Uint8Array(written);
}

/** One 512-byte ustar header with a correct checksum. */
function tarHeader(name: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) block[at + i] = text.charCodeAt(i) & 0xff;
  };

  put(0, name);
  put(100, "0000644\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");

  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);

  return block;
}

/** A tar holding one small member, correctly terminated. */
function realTar(): Uint8Array {
  const body = new Uint8Array(BLOCK);
  body.set(
    Uint8Array.from("hello", (c) => c.charCodeAt(0)),
    0,
  );
  const out = new Uint8Array(BLOCK * 4);
  out.set(tarHeader("hello.txt", 5), 0);
  out.set(body, BLOCK);
  return out;
}

interface Served {
  /** Every `Range` header the code under test sent, in order. */
  readonly ranges: (string | null)[];
  /** How many bytes were actually handed back. */
  bytesServed: number;
}

/**
 * Serve `bytes` over a fake `fetch` that honours byte ranges.
 *
 * The range arithmetic matters: a reader that asked for the tail and got the
 * whole file would still parse correctly and would silently defeat the reason
 * ranges exist. The counters are what make that a test rather than a hope.
 */
function serve(bytes: Uint8Array): Served {
  const served: Served = { ranges: [], bytesServed: 0 };

  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    const header = new Headers(init?.headers).get("range");
    served.ranges.push(header);

    const match = header === null ? null : /^bytes=(\d+)-(\d+)$/.exec(header);
    const slice =
      match === null
        ? bytes
        : bytes.subarray(Number(match[1]), Math.min(Number(match[2]) + 1, bytes.length));

    served.bytesServed += slice.length;
    return Promise.resolve(
      new Response(slice.slice(), {
        status: match === null ? 200 : 206,
        headers: { "content-length": String(slice.length) },
      }),
    );
  });

  return served;
}

describe("readArchive, for a zip", () => {
  /**
   * This asserts the SHAPE of the fetching, not its byte budget.
   *
   * A first version asserted the total bytes read were fewer than the file's
   * length, and that cannot hold here: the reader asks for `min(size, 65557)`
   * tail bytes, so for a fixture smaller than that window the tail read IS the
   * whole file. The budget is real, and it is pinned where it can be — in
   * `packages/fm-core/test/zip.test.ts`, against an archive DECLARING two
   * gigabytes with a `ByteSource` that counts every range it is asked for.
   *
   * What only this package can prove is what the previous line cannot see:
   * that the request actually goes out as a `Range`.
   */
  it("reads the index with byte ranges rather than fetching the archive", async () => {
    const bytes = realZip();
    const served = serve(bytes);

    const result = await readArchive(URL_UNDER_TEST, "zip", "none", bytes.length);

    expect(result.kind).toBe("listing");
    if (result.kind !== "listing") return;
    expect(result.listing.fileCount).toBeGreaterThan(0);

    // Every request carried a range — no plain GET of the whole archive — and
    // there were two or three of them rather than a walk.
    expect(served.ranges.every((range) => range?.startsWith("bytes=") === true)).toBe(true);
    expect(served.ranges.length).toBeLessThanOrEqual(3);
  });

  it("reports a zip it cannot read rather than an empty listing", async () => {
    const notAZip = new Uint8Array(4096).fill(0x7a);
    serve(notAZip);

    const result = await readArchive(URL_UNDER_TEST, "zip", "none", notAZip.length);

    expect(result).toEqual({ kind: "unreadable" });
  });
});

describe("readArchive, for a tar", () => {
  it("lists a plain tar from the response body", async () => {
    const bytes = realTar();
    serve(bytes);

    const result = await readArchive(URL_UNDER_TEST, "tar", "none", bytes.length);

    expect(result.kind).toBe("listing");
    if (result.kind !== "listing") return;
    expect(result.listing.rows.map((row) => row.path)).toEqual(["hello.txt"]);
    expect(result.partial).toBe(false);
  });

  it("decompresses a gzip-compressed tar rather than reading it raw", async () => {
    const bytes = new Uint8Array(gzipSync(Buffer.from(realTar())));
    serve(bytes);

    const result = await readArchive(URL_UNDER_TEST, "tar", "gzip", bytes.length);

    expect(result.kind).toBe("listing");
    if (result.kind !== "listing") return;
    // The member's name only exists after decompression. Reading the gzip's
    // own bytes as a tar answers `notAnArchive`, which is the failure this
    // asserts against.
    expect(result.listing.rows.map((row) => row.path)).toEqual(["hello.txt"]);
  });

  it("reports a gzip that is not a tar rather than an empty listing", async () => {
    // `notes.txt.gz` — an ordinary file to land the cursor on, and not an
    // archive. The router cannot tell; this is where it is told.
    const bytes = new Uint8Array(gzipSync(Buffer.from("just some prose, at length.\n".repeat(40))));
    serve(bytes);

    const result = await readArchive(URL_UNDER_TEST, "tar", "gzip", bytes.length);

    expect(result).toEqual({ kind: "unreadable" });
  });

  it("says the counts are a lower bound when the walk stopped early", async () => {
    // One header claiming a gigabyte, so the byte ceiling ends the walk. The
    // listing is real but incomplete, and a pane that presented its counts as
    // the archive's would be stating a wrong number as a fact.
    const head = tarHeader("enormous.bin", 1024 * 1024 * 1024);
    const bytes = new Uint8Array(BLOCK * 200);
    bytes.set(head, 0);
    serve(bytes);

    const result = await readArchive(URL_UNDER_TEST, "tar", "none", bytes.length, {
      maxBytes: BLOCK * 4,
    });

    expect(result.kind).toBe("listing");
    if (result.kind !== "listing") return;
    expect(result.partial).toBe(true);
  });
});
