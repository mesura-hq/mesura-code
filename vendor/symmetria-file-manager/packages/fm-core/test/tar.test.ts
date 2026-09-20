import { describe, expect, it } from "vitest";

import { readTarIndex } from "../src/preview/archive/tar.ts";
import { ascii, decodeAscii } from "./support/bytes.ts";

/**
 * The tar walker.
 *
 * A tar has no index, so every fact about it comes from walking 512-byte
 * headers and stepping over the data between them. These fixtures build those
 * blocks by hand for the same reason the zip ones do — this package has no
 * `node:fs` to read a real tarball with and no `TextEncoder` to write one.
 */

const BLOCK = 512;

interface HeaderFields {
  readonly name: string;
  readonly size?: number;
  /** `0` regular, `5` directory, `L` GNU long name, `x` pax. Defaults to `0`. */
  readonly typeflag?: string;
  /** The ustar field that carries the leading part of a long path. */
  readonly prefix?: string;
  /** Corrupt the checksum, to make a block that is not a header. */
  readonly breakChecksum?: boolean;
}

function writeAscii(block: Uint8Array, at: number, text: string, width: number): void {
  const bytes = ascii(text);
  for (let i = 0; i < Math.min(bytes.length, width); i++) block[at + i] = bytes[i] ?? 0;
}

/** An octal field, NUL-terminated, as tar writes every number. */
function writeOctal(block: Uint8Array, at: number, value: number, width: number): void {
  writeAscii(block, at, value.toString(8).padStart(width - 1, "0"), width);
}

function header(fields: HeaderFields): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const size = fields.size ?? 0;

  writeAscii(block, 0, fields.name, 100);
  writeOctal(block, 100, 0o644, 8);
  writeOctal(block, 108, 0, 8);
  writeOctal(block, 116, 0, 8);
  writeOctal(block, 124, size, 12);
  writeOctal(block, 136, 0, 12);
  writeAscii(block, 148, "        ", 8); // the checksum field reads as spaces while summing
  writeAscii(block, 156, fields.typeflag ?? "0", 1);
  writeAscii(block, 257, "ustar", 6);
  writeAscii(block, 263, "00", 2);
  writeAscii(block, 345, fields.prefix ?? "", 155);

  let sum = 0;
  for (const byte of block) sum += byte;
  if (fields.breakChecksum === true) sum += 1;
  // Six octal digits, a NUL, then a space. The format's own odd convention.
  writeAscii(block, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);

  return block;
}

/**
 * One pax record: `"<length> <key>=<value>\n"`.
 *
 * The length counts its own digits, the space and the newline, so it is
 * defined in terms of itself and is solved by iterating to a fixed point.
 * Writing it by hand is how the first version of this fixture came to declare
 * 30 where the answer is 29 — invisible while the walker skipped the body.
 */
function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = body.length;
  while (`${length}`.length + 1 + body.length !== length) {
    length = `${length}`.length + 1 + body.length;
  }
  return `${length} ${body}`;
}

/** A member's content, padded out to the next block boundary. */
function content(text: string): Uint8Array {
  const bytes = ascii(text);
  const padded = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  padded.set(bytes, 0);
  return padded;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The two all-zero blocks that end a tar. */
function endOfArchive(): Uint8Array {
  return new Uint8Array(BLOCK * 2);
}

interface CountingStream extends AsyncIterable<Uint8Array> {
  /** How many bytes the walker actually pulled, for the stop-early assertions. */
  readonly pulled: () => number;
}

/**
 * The bytes, in chunks of a chosen size.
 *
 * The chunk size is a parameter because a 512-byte header straddling a chunk
 * boundary is the thing a stream walker breaks on first, and a fixture that
 * always hands over the whole archive at once would never produce one.
 */
function streamOf(bytes: Uint8Array, chunkSize = bytes.length): CountingStream {
  let pulled = 0;
  return {
    pulled: () => pulled,
    async *[Symbol.asyncIterator]() {
      for (let at = 0; at < bytes.length; at += chunkSize) {
        const chunk = bytes.subarray(at, Math.min(at + chunkSize, bytes.length));
        pulled += chunk.length;
        yield chunk;
      }
    },
  };
}

describe("readTarIndex", () => {
  it("reports every entry's path, size and kind", async () => {
    const bytes = concat([
      header({ name: "notes/", typeflag: "5" }),
      header({ name: "notes/one.txt", size: 5 }),
      content("hello"),
      header({ name: "notes/two.txt", size: 11 }),
      content("hello world"),
      endOfArchive(),
    ]);

    const result = await readTarIndex(streamOf(bytes), decodeAscii);

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toEqual([
      { path: "notes/", size: 0, isDirectory: true },
      { path: "notes/one.txt", size: 5, isDirectory: false },
      { path: "notes/two.txt", size: 11, isDirectory: false },
    ]);
    expect(result.stopped).toBeNull();
  });

  it("joins the prefix field to the name, so a long ustar path is whole", async () => {
    const prefix = "a-very/deeply/nested/directory/that/exceeds/the/hundred/character/name/field";
    const bytes = concat([
      header({ name: "deep.txt", prefix, size: 3 }),
      content("abc"),
      endOfArchive(),
    ]);

    const result = await readTarIndex(streamOf(bytes), decodeAscii);

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries[0]?.path).toBe(`${prefix}/deep.txt`);
  });

  it("applies a GNU long name to the entry that follows it", async () => {
    const longName = `${"x".repeat(150)}/payload.bin`;
    const bytes = concat([
      header({ name: "././@LongLink", typeflag: "L", size: longName.length }),
      content(longName),
      // The truncated name the long-link entry exists to replace.
      header({ name: longName.slice(0, 100), size: 4 }),
      content("data"),
      endOfArchive(),
    ]);

    const result = await readTarIndex(streamOf(bytes), decodeAscii);

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toEqual([{ path: longName, size: 4, isDirectory: false }]);
  });

  it("does not report a pax header block as a file entry", async () => {
    const pax = paxRecord("mtime", "1690000000.000000000");
    const bytes = concat([
      header({ name: "PaxHeaders/one.txt", typeflag: "x", size: pax.length }),
      content(pax),
      header({ name: "one.txt", size: 2 }),
      content("hi"),
      endOfArchive(),
    ]);

    const result = await readTarIndex(streamOf(bytes), decodeAscii);

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toEqual([{ path: "one.txt", size: 2, isDirectory: false }]);
  });

  it("applies a pax path record to the entry that follows it", async () => {
    // The half of criterion 4 the first pax spec could not see. A pax body is
    // not decoration: it carries the `path=` that OVERRIDES the 100-byte ustar
    // name field, and bsdtar picks pax by default once a name is longer than
    // that. A walker that skips the body truncates ordinary long names.
    const longName = `${"c".repeat(150)}.txt`;
    const pax = paxRecord("path", longName);

    const bytes = concat([
      header({ name: "PaxHeaders/long", typeflag: "x", size: pax.length }),
      content(pax),
      header({ name: longName.slice(0, 100), size: 7 }),
      content("payload"),
      endOfArchive(),
    ]);

    const result = await readTarIndex(streamOf(bytes), decodeAscii);

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toEqual([{ path: longName, size: 7, isDirectory: false }]);
  });

  it("answers notAnArchive for a stream shorter than a single block", async () => {
    // A small gzipped text file decompresses to this. It used to answer
    // "an empty archive", which is a different and less honest claim.
    const short = new Uint8Array(200).fill(0x41);

    await expect(readTarIndex(streamOf(short), decodeAscii)).resolves.toEqual({
      kind: "notAnArchive",
    });
  });

  it("stops at the two zero blocks and does not read what follows them", async () => {
    const trailing = concat([header({ name: "after-the-end.txt", size: 4 }), content("junk")]);
    const bytes = concat([
      header({ name: "real.txt", size: 4 }),
      content("real"),
      endOfArchive(),
      trailing,
    ]);

    const stream = streamOf(bytes, BLOCK);
    const result = await readTarIndex(stream, decodeAscii);

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries.map((entry) => entry.path)).toEqual(["real.txt"]);
    // Four blocks: the header, its content, and the two zeros. Anything more
    // means the walker kept pulling after the archive said it had ended.
    expect(stream.pulled()).toBeLessThanOrEqual(BLOCK * 4);
  });

  it("stops at the entry cap, says so, and leaves the rest of the stream unread", async () => {
    const many: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) many.push(header({ name: `f${i}.txt` }));
    const bytes = concat([...many, endOfArchive()]);

    const stream = streamOf(bytes, BLOCK);
    const result = await readTarIndex(stream, decodeAscii, { maxEntries: 10 });

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toHaveLength(10);
    expect(result.stopped).toBe("cap");
    expect(stream.pulled()).toBeLessThan(bytes.length);
  });

  it("stops at the byte ceiling, says so, and leaves the rest of the stream unread", async () => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) {
      parts.push(header({ name: `f${i}.txt`, size: 10 }), content("0123456789"));
    }
    const bytes = concat([...parts, endOfArchive()]);

    const stream = streamOf(bytes, BLOCK);
    const result = await readTarIndex(stream, decodeAscii, { maxBytes: BLOCK * 8 });

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.stopped).toBe("ceiling");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(stream.pulled()).toBeLessThan(bytes.length);
  });

  it("answers notAnArchive when the first block's checksum does not verify", async () => {
    // What a gzip of an ordinary text file decompresses to: bytes that are not
    // a header and never claimed to be. Without the checksum test this reads as
    // a tarball full of garbage names.
    const notATar = concat([header({ name: "looks-real.txt", size: 4, breakChecksum: true })]);

    await expect(readTarIndex(streamOf(notATar), decodeAscii)).resolves.toEqual({
      kind: "notAnArchive",
    });
  });

  it("answers notAnArchive for arbitrary bytes that are not blocks at all", async () => {
    const prose = new Uint8Array(2048).fill(0x41);

    await expect(readTarIndex(streamOf(prose), decodeAscii)).resolves.toEqual({
      kind: "notAnArchive",
    });
  });

  it("parses a header that straddles a chunk boundary", async () => {
    const bytes = concat([
      header({ name: "notes/one.txt", size: 5 }),
      content("hello"),
      header({ name: "notes/two.txt", size: 11 }),
      content("hello world"),
      endOfArchive(),
    ]);

    // 100 does not divide 512, so every header after the first begins mid-chunk.
    const chunked = await readTarIndex(streamOf(bytes, 100), decodeAscii);
    const whole = await readTarIndex(streamOf(bytes), decodeAscii);

    expect(chunked).toEqual(whole);
    expect(chunked.kind).toBe("index");
    if (chunked.kind !== "index") return;
    expect(chunked.entries.map((entry) => entry.path)).toEqual(["notes/one.txt", "notes/two.txt"]);
  });
});

/**
 * What a corrupt or hostile tarball costs.
 *
 * Two of these came from the phase's review, which observed that the byte
 * ceiling was checked only BETWEEN header blocks — so one member declaring
 * forty gigabytes drained forty gigabytes before the bound was consulted
 * again. The rest cover the three things this walker does that no acceptance
 * criterion asked for and no test therefore reached.
 */
describe("readTarIndex, against archives that lie about their sizes", () => {
  /** Rewrite a block's checksum, after its bytes have been tampered with. */
  function resign(block: Uint8Array, style: "unsigned" | "signed" = "unsigned"): Uint8Array {
    const out = Uint8Array.from(block);
    writeAscii(out, 148, "        ", 8);

    let sum = 0;
    for (const byte of out) sum += style === "signed" && byte > 127 ? byte - 256 : byte;

    writeAscii(out, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
    return out;
  }

  /**
   * One header, then an endless-looking run of zeros.
   *
   * Bounded at two megabytes so a walker that ignores its ceiling fails the
   * assertion instead of hanging the suite — a test that times out reports the
   * defect far less clearly than one that fails.
   */
  function paddedStream(head: Uint8Array, chunkSize = BLOCK): CountingStream {
    const total = 2 * 1024 * 1024;
    let pulled = 0;
    return {
      pulled: () => pulled,
      async *[Symbol.asyncIterator]() {
        yield head;
        pulled += head.length;
        while (pulled < total) {
          const chunk = new Uint8Array(chunkSize);
          pulled += chunk.length;
          yield chunk;
        }
      },
    };
  }

  it("stops pulling at the byte ceiling even inside a single member", async () => {
    // ONE entry declaring a gigabyte. The ceiling used to be checked only
    // between headers, so the walk stepped over the whole member first and
    // reported the bound afterwards — which is the bound doing nothing.
    const head = header({ name: "enormous.bin", size: 1024 * 1024 * 1024 });

    const stream = paddedStream(head);
    const result = await readTarIndex(stream, decodeAscii, { maxBytes: 4096 });

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.stopped).toBe("ceiling");
    expect(result.entries).toEqual([
      { path: "enormous.bin", size: 1024 * 1024 * 1024, isDirectory: false },
    ]);
    // One chunk of slack past the ceiling. Two megabytes means it drained.
    expect(stream.pulled()).toBeLessThanOrEqual(4096 + BLOCK);
  });

  it("refuses a metadata body that declares an absurd length", async () => {
    // A long-name block claiming a hundred megabytes. Its length comes off disk
    // with nothing vouching for it, and buffering what it claims is how a
    // bounded reader becomes an unbounded one.
    const head = header({ name: "././@LongLink", typeflag: "L", size: 100 * 1024 * 1024 });

    const stream = paddedStream(head);
    const result = await readTarIndex(stream, decodeAscii);

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toEqual([]);
    // The header block and nothing more. Without the cap the default ceiling
    // still bounds it, but at sixty-four megabytes rather than at one block.
    expect(stream.pulled()).toBeLessThanOrEqual(BLOCK * 4);
  });

  it("reads a size written in base 256, which is how tar records a huge member", async () => {
    const real = 10 * 1024 * 1024 * 1024;
    const block = Uint8Array.from(header({ name: "huge.bin" }));

    // The high bit of the first byte switches the field from octal digits to
    // big-endian binary. Octal cannot express a member over eight gigabytes.
    const field = new Uint8Array(12);
    field[0] = 0x80;
    let left = real;
    for (let i = 11; i >= 1; i--) {
      field[i] = left % 256;
      left = Math.floor(left / 256);
    }
    block.set(field, 124);

    const result = await readTarIndex(paddedStream(resign(block)), decodeAscii, {
      maxBytes: 4096,
    });

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries[0]?.size).toBe(real);
  });

  it("accepts a header whose checksum was summed as signed bytes", async () => {
    // Historic writers summed the block as signed `char`. The two sums differ
    // only once a field holds a byte above 127 — which is a non-ASCII
    // filename, so refusing them would refuse real archives.
    const block = Uint8Array.from(header({ name: "cafe.txt", size: 4 }));
    block[0] = 0xc3;
    block[1] = 0xa9;

    const bytes = concat([resign(block, "signed"), content("data"), endOfArchive()]);
    const result = await readTarIndex(streamOf(bytes), decodeAscii);

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.size).toBe(4);
  });

  it("calls a first read cut short by the ceiling a stop, not a refusal", async () => {
    // The ceiling can now end a read before one whole block exists. That is a
    // listing that stopped; answering `notAnArchive` would turn a bound this
    // reader imposed into an accusation about the file.
    const bytes = concat([header({ name: "fine.txt", size: 4 }), content("data"), endOfArchive()]);

    const result = await readTarIndex(streamOf(bytes, 1), decodeAscii, { maxBytes: 100 });

    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    expect(result.stopped).toBe("ceiling");
    expect(result.entries).toEqual([]);
  });
});
