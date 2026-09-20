import { describe, expect, it } from "vitest";

import type { ByteSource } from "../src/preview/archive/types.ts";
import { readZipIndex } from "../src/preview/archive/zip.ts";
import { ascii, decodeAscii, u16, u32, u64 } from "./support/bytes.ts";

/**
 * The zip index reader.
 *
 * ── Why every fixture is built here, byte by byte ───────────────────────────
 * This package compiles with `lib: ["ES2023"]` and `types: []`, and its
 * `include` covers this directory — so there is no `node:fs` to read a real
 * archive with, and no `TextEncoder` to make one with either. Every helper
 * below exists for that reason rather than for tidiness.
 *
 * It is also the better fixture. A 65535-byte archive comment and a ZIP64
 * sentinel are two lines here and a nuisance to obtain from a real zip.
 */

const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

interface FixtureEntry {
  readonly name: string;
  readonly size: number;
  /** The general purpose bit flag. Bit 0 encrypts data, bit 13 the directory. */
  readonly flag?: number;
  /**
   * What goes in the two 32-bit size fields, when it is not `size`.
   *
   * Only ever `0xffffffff`, which is how a member says its real size is in the
   * extra field below.
   */
  readonly sizeField?: number;
  /** The extra field, verbatim. Used to carry a ZIP64 size. */
  readonly extra?: number[];
}

/** A ZIP64 extended-information extra field carrying one uncompressed size. */
function zip64SizeExtra(size: number): number[] {
  return [...u16(0x0001), ...u16(8), ...u64(size)];
}

/** One central directory file header. */
function centralHeader(entry: FixtureEntry, localOffset: number): number[] {
  const name = ascii(entry.name);
  const extra = entry.extra ?? [];
  const sizeField = entry.sizeField ?? entry.size;
  return [
    ...u32(CENTRAL_SIGNATURE),
    ...u16(20), // version made by
    ...u16(20), // version needed
    ...u16(entry.flag ?? 0),
    ...u16(8), // deflate
    ...u16(0), // last mod time
    ...u16(0), // last mod date
    ...u32(0), // crc32
    ...u32(sizeField), // compressed size
    ...u32(sizeField), // uncompressed size
    ...u16(name.length),
    ...u16(extra.length),
    ...u16(0), // comment length
    ...u16(0), // disk number start
    ...u16(0), // internal attributes
    ...u32(0), // external attributes
    ...u32(localOffset),
    ...name,
    ...extra,
  ];
}

interface Archive {
  /** What the archive claims to be, which may be far larger than `trailing`. */
  readonly size: number;
  /** The absolute offset the `trailing` bytes begin at. */
  readonly start: number;
  readonly trailing: Uint8Array;
}

interface BuildOptions {
  readonly entries: readonly FixtureEntry[];
  /** How large the archive claims to be. Defaults to just fitting the bytes. */
  readonly declaredSize?: number;
  readonly comment?: number[];
  /** Write the ZIP64 sentinels into the classic record and add the real one. */
  readonly zip64?: boolean;
  /** Claim a central directory larger than the archive can hold. */
  readonly overrunCentralDirectory?: boolean;
}

const ZIP64_RECORD_LENGTH = 56;
const ZIP64_LOCATOR_LENGTH = 20;
/** How long the ZIP64 record and its locator are together, or zero without them. */
const ZIP64_BLOCK = ZIP64_RECORD_LENGTH + ZIP64_LOCATOR_LENGTH;
const EOCD_LENGTH = 22;

/** The ZIP64 end record and the locator that points at it, in that order. */
function zip64Block(entryCount: number, centralLength: number, centralOffset: number): number[] {
  return [
    ...u32(ZIP64_EOCD_SIGNATURE),
    ...u64(44),
    ...u16(45),
    ...u16(45),
    ...u32(0),
    ...u32(0),
    ...u64(entryCount),
    ...u64(entryCount),
    ...u64(centralLength),
    ...u64(centralOffset),
    ...u32(ZIP64_LOCATOR_SIGNATURE),
    ...u32(0),
    ...u64(centralOffset + centralLength),
    ...u32(1),
  ];
}

interface EndFields {
  readonly count: number;
  readonly centralSize: number;
  readonly centralOffset: number;
  readonly comment: number[];
}

/** The classic end-of-central-directory record, and whatever comment follows it. */
function endRecord({ count, centralSize, centralOffset, comment }: EndFields): number[] {
  return [
    ...u32(EOCD_SIGNATURE),
    ...u16(0),
    ...u16(0),
    ...u16(count),
    ...u16(count),
    ...u32(centralSize),
    ...u32(centralOffset),
    ...u16(comment.length),
    ...comment,
  ];
}

/**
 * A zip, from its central directory backwards.
 *
 * No local file headers: the reader never looks at them, and a fixture that
 * carried them would be asserting they are ignored rather than that the index
 * is read.
 *
 * Laid out backwards from the end, because the absolute offsets have to be
 * known before the bytes exist: filler, central directory, the ZIP64 block
 * where there is one, the end record, the comment.
 */
function buildArchive(options: BuildOptions): Archive {
  const central: number[] = [];
  for (const entry of options.entries) central.push(...centralHeader(entry, 0));

  const comment = options.comment ?? [];
  const zip64 = options.zip64 === true;

  const trailingLength = central.length + (zip64 ? ZIP64_BLOCK : 0) + EOCD_LENGTH + comment.length;
  const declaredSize = options.declaredSize ?? trailingLength;
  const centralOffset = declaredSize - trailingLength;

  const block = zip64 ? zip64Block(options.entries.length, central.length, centralOffset) : [];
  const end = endRecord({
    // The sentinels are how an archive says the real values are in the ZIP64
    // record, so a ZIP64 fixture writes them here and nothing else.
    count: zip64 ? 0xffff : options.entries.length,
    centralSize: zip64 ? 0xffffffff : centralSizeOf(options, central.length, declaredSize),
    centralOffset: zip64 ? 0xffffffff : centralOffset,
    comment,
  });

  return {
    size: declaredSize,
    start: centralOffset,
    trailing: Uint8Array.from([...central, ...block, ...end]),
  };
}

/** A directory size that will not fit the archive, when the fixture asks for one. */
function centralSizeOf(options: BuildOptions, actual: number, declaredSize: number): number {
  return options.overrunCentralDirectory === true ? declaredSize + 4096 : actual;
}

interface CountingSource extends ByteSource {
  /** Every range asked for, in order, so a read budget can be asserted. */
  readonly reads: { start: number; length: number }[];
  readonly totalBytesRead: () => number;
}

/**
 * A source over an archive whose bytes exist only near the end.
 *
 * Anything before `start` reads as zeros, which is what makes a two-gigabyte
 * archive representable in a test at all — and what makes the read budget a
 * real assertion rather than a claim.
 */
function sourceOver(archive: Archive): CountingSource {
  const reads: { start: number; length: number }[] = [];

  return {
    size: archive.size,
    reads,
    totalBytesRead: () => reads.reduce((sum, read) => sum + read.length, 0),
    read(start: number, length: number): Promise<Uint8Array> {
      reads.push({ start, length });
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        const absolute = start + i;
        const inTrailing = absolute - archive.start;
        if (inTrailing >= 0 && inTrailing < archive.trailing.length) {
          out[i] = archive.trailing[inTrailing] ?? 0;
        }
      }
      return Promise.resolve(out);
    },
    decodeText: decodeAscii,
  };
}

describe("readZipIndex", () => {
  it("reports every entry's path, size and kind", async () => {
    const result = await readZipIndex(
      sourceOver(
        buildArchive({
          entries: [
            { name: "notes.txt", size: 1234 },
            { name: "game/data.rpa", size: 987654 },
          ],
        }),
      ),
    );

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toEqual([
      { path: "notes.txt", size: 1234, isDirectory: false },
      { path: "game/data.rpa", size: 987654, isDirectory: false },
    ]);
  });

  it("finds the end record behind an archive comment of the maximum length", async () => {
    const comment = new Array<number>(65535).fill(0x41);
    // The signature bytes, planted inside the comment. A reader scanning
    // forwards finds this one first and reads garbage; scanning backwards from
    // the end finds the real record.
    comment[0] = 0x50;
    comment[1] = 0x4b;
    comment[2] = 0x05;
    comment[3] = 0x06;

    const result = await readZipIndex(
      sourceOver(buildArchive({ entries: [{ name: "a.txt", size: 7 }], comment })),
    );

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe("a.txt");
  });

  it("follows the ZIP64 locator when the classic record carries its sentinels", async () => {
    const result = await readZipIndex(
      sourceOver(
        buildArchive({
          zip64: true,
          entries: [
            { name: "big/one.bin", size: 10 },
            { name: "big/two.bin", size: 20 },
          ],
        }),
      ),
    );

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries.map((entry) => entry.path)).toEqual(["big/one.bin", "big/two.bin"]);
  });

  it("reads kilobytes, not the archive, when the archive is two gigabytes", async () => {
    const source = sourceOver(
      buildArchive({
        declaredSize: 2 * 1024 * 1024 * 1024,
        entries: [
          { name: "game/data.rpa", size: 1_400_000_000 },
          { name: "game/patreon.rpa", size: 189_000_000 },
        ],
      }),
    );

    const result = await readZipIndex(source);

    expect(result.kind).toBe("index");
    expect(source.totalBytesRead()).toBeLessThan(1024 * 1024);
    // Every read lands in the tail. A reader that walked the archive from the
    // front would satisfy the budget above for a small enough fixture.
    for (const read of source.reads) {
      expect(read.start).toBeGreaterThan(2 * 1024 * 1024 * 1024 - 1024 * 1024);
    }
  });

  it("lists the names in an archive whose file data is encrypted", async () => {
    const result = await readZipIndex(
      sourceOver(
        buildArchive({
          // Bit 0: the file data is encrypted. The central directory is not.
          entries: [{ name: "secret.pdf", size: 4096, flag: 0x0001 }],
        }),
      ),
    );

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries[0]?.path).toBe("secret.pdf");
  });

  it("refuses an archive whose central directory is itself encrypted", async () => {
    const result = await readZipIndex(
      // Bit 13: strong encryption, the central directory included.
      sourceOver(buildArchive({ entries: [{ name: "secret.pdf", size: 1, flag: 0x2000 }] })),
    );

    expect(result).toEqual({ kind: "unreadable", reason: "encrypted-index" });
  });

  it("answers unreadable rather than throwing for bytes that are not a zip", async () => {
    const notAZip: ByteSource = {
      size: 4096,
      read: (_start, length) => Promise.resolve(new Uint8Array(length).fill(0x7a)),
      decodeText: decodeAscii,
    };

    await expect(readZipIndex(notAZip)).resolves.toEqual({
      kind: "unreadable",
      reason: "not-a-zip",
    });
  });

  it("answers unreadable rather than throwing for an empty file", async () => {
    const empty: ByteSource = {
      size: 0,
      read: () => Promise.resolve(new Uint8Array(0)),
      decodeText: decodeAscii,
    };

    await expect(readZipIndex(empty)).resolves.toEqual({ kind: "unreadable", reason: "not-a-zip" });
  });

  it("answers unreadable when the central directory runs past the archive", async () => {
    const result = await readZipIndex(
      sourceOver(
        buildArchive({ entries: [{ name: "a.txt", size: 1 }], overrunCentralDirectory: true }),
      ),
    );

    expect(result).toEqual({ kind: "unreadable", reason: "truncated" });
  });

  it("reports a name ending in a slash as a directory carrying no size", async () => {
    const result = await readZipIndex(
      sourceOver(
        buildArchive({
          entries: [
            // A real writer emits zero here; this one does not, so the reader
            // is what has to normalise it.
            { name: "game/cache/", size: 4096 },
            { name: "game/cache/build_info.json", size: 89 },
          ],
        }),
      ),
    );

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toEqual([
      { path: "game/cache/", size: 0, isDirectory: true },
      { path: "game/cache/build_info.json", size: 89, isDirectory: false },
    ]);
  });
});

/**
 * The paths a corrupt or self-contradictory archive takes.
 *
 * Every one of these is a regression guard rather than a spec: four came from
 * the phase's own review, which observed that the ZIP64 branches and the
 * per-member size sentinel were reachable only by reading the code. The fifth
 * pins the defect that review found — a member declaring a size it does not
 * supply used to be reported AS `0xffffffff`, which is 4.0 GB stated as a fact.
 */
describe("readZipIndex, against archives that contradict themselves", () => {
  /** Overwrite bytes at an offset inside the trailing block, in place. */
  function patched(archive: Archive, at: number, bytes: number[]): Archive {
    const trailing = Uint8Array.from(archive.trailing);
    for (let i = 0; i < bytes.length; i++) trailing[at + i] = bytes[i] ?? 0;
    return { ...archive, trailing };
  }

  /** Where the ZIP64 locator begins, given how `buildArchive` lays a zip64 out. */
  function locatorAt(centralLength: number): number {
    return centralLength + ZIP64_RECORD_LENGTH;
  }

  it("reports a member's real size from the ZIP64 extra field", async () => {
    const real = 6 * 1024 * 1024 * 1024;
    const result = await readZipIndex(
      sourceOver(
        buildArchive({
          entries: [
            { name: "huge.bin", size: real, sizeField: 0xffffffff, extra: zip64SizeExtra(real) },
          ],
        }),
      ),
    );

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries[0]?.size).toBe(real);
  });

  it("refuses a member that declares a ZIP64 size and does not supply one", async () => {
    // The sentinel with no extra field to resolve it. Reporting 0xffffffff
    // here would be the exact 4.0 GB the reader exists to avoid inventing.
    const result = await readZipIndex(
      sourceOver(buildArchive({ entries: [{ name: "huge.bin", size: 0, sizeField: 0xffffffff }] })),
    );

    expect(result).toEqual({ kind: "unreadable", reason: "malformed" });
  });

  it("refuses a ZIP64 locator whose signature is wrong", async () => {
    const central = centralHeader({ name: "a.txt", size: 1 }, 0).length;
    const archive = buildArchive({ zip64: true, entries: [{ name: "a.txt", size: 1 }] });

    const result = await readZipIndex(sourceOver(patched(archive, locatorAt(central), [0x00])));

    expect(result).toEqual({ kind: "unreadable", reason: "unsupported" });
  });

  it("refuses a ZIP64 locator pointing past the end of the archive", async () => {
    const central = centralHeader({ name: "a.txt", size: 1 }, 0).length;
    const archive = buildArchive({ zip64: true, entries: [{ name: "a.txt", size: 1 }] });

    const result = await readZipIndex(
      // The locator's 64-bit offset sits eight bytes into it.
      sourceOver(patched(archive, locatorAt(central) + 8, u64(archive.size))),
    );

    expect(result).toEqual({ kind: "unreadable", reason: "truncated" });
  });

  it("ignores an end record whose comment length does not account for the tail", async () => {
    // A plausible signature IS present, unlike the two `not-a-zip` specs above
    // which contain none at all. This is the shape a truncated tail takes: the
    // record is found and then fails to describe the bytes around it.
    const comment = [0x21, 0x21, 0x21];
    const archive = buildArchive({ entries: [{ name: "a.txt", size: 1 }], comment });
    const central = centralHeader({ name: "a.txt", size: 1 }, 0).length;

    const result = await readZipIndex(
      // The comment-length field is 20 bytes into the end record.
      sourceOver(patched(archive, central + 20, u16(99))),
    );

    expect(result).toEqual({ kind: "unreadable", reason: "not-a-zip" });
  });
});
