import { type ByteStream, byteStream } from "./byteStream.ts";
import { type ArchiveEntry, MAX_ARCHIVE_ENTRIES } from "./types.ts";

/**
 * A tar's members, from walking it.
 *
 * ── Why this streams and the zip reader does not ────────────────────────────
 * A tar has no index. Its structure IS the walk: a 512-byte header, then the
 * member's data rounded up to the next block, then the next header. So there is
 * no address to seek to and nothing to read but the whole thing in order —
 * which is why this takes an `AsyncIterable` and steps over data it never
 * holds, while `zip.ts` takes random access and reads two ranges.
 *
 * ── Both bounds are load-bearing ────────────────────────────────────────────
 * An unbounded walk is the failure this design has to avoid: a 40 GB tarball
 * under the cursor must cost a bounded read, not a full decompression. The
 * entry cap stops a tar of a million tiny files; the byte ceiling stops a tar
 * of a few enormous ones. Neither is an error — the walk reports which one it
 * hit so the pane can say the listing is partial.
 */

const BLOCK = 512;

/**
 * How much decompressed stream one listing may pull.
 *
 * Generous for the headers of five thousand members, which is the most that
 * will ever be shown, and small enough that a huge tarball costs a fraction of
 * a second rather than a full read.
 */
export const MAX_TAR_BYTES = 64 * 1024 * 1024;

/**
 * The most a single metadata body may be, before the walk gives up on it.
 *
 * A GNU long name or a pax record set is a few kilobytes at the very most, and
 * its declared length comes straight off disk with nothing vouching for it. So
 * a corrupt or hostile archive can name a size and have it believed. One
 * megabyte is far past anything legitimate and far short of anything that
 * matters, and the walk stops rather than buffering what a header claims.
 */
const MAX_METADATA_BYTES = 1024 * 1024;

/** Offsets into the header block. The format's own layout, unchanged since v7. */
const NAME_AT = 0;
const NAME_WIDTH = 100;
const SIZE_AT = 124;
const SIZE_WIDTH = 12;
const CHECKSUM_AT = 148;
const CHECKSUM_WIDTH = 8;
const TYPEFLAG_AT = 156;
const PREFIX_AT = 345;
const PREFIX_WIDTH = 155;

/** Type flags this reader treats specially. Everything else is a file. */
const TYPE_DIRECTORY = 0x35; // "5"
const TYPE_GNU_LONG_NAME = 0x4c; // "L"
const TYPE_GNU_LONG_LINK = 0x4b; // "K"
const TYPE_PAX_ENTRY = 0x78; // "x"
const TYPE_PAX_GLOBAL = 0x67; // "g"

/** Which bound ended the walk early, or `null` where the archive ended first. */
export type TarStop = "cap" | "ceiling" | null;

export type TarIndex =
  | {
      readonly kind: "index";
      readonly entries: readonly ArchiveEntry[];
      readonly stopped: TarStop;
    }
  /** The first block is not a header, so these bytes were never a tar. */
  | { readonly kind: "notAnArchive" };

export interface TarLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

/** Bytes to a string, supplied by the caller. See `types.ts` for why. */
type DecodeText = (bytes: Uint8Array) => string;

function roundUpToBlock(length: number): number {
  return Math.ceil(length / BLOCK) * BLOCK;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/** A NUL-terminated field, trimmed at the first NUL rather than at its width. */
function field(block: Uint8Array, at: number, width: number, decodeText: DecodeText): string {
  const raw = block.subarray(at, at + width);
  const end = raw.indexOf(0);
  return decodeText(end === -1 ? raw : raw.subarray(0, end));
}

/**
 * A numeric field: octal, or base-256 for a value octal cannot hold.
 *
 * GNU tar sets the high bit of the first byte and writes the number as
 * big-endian binary when a member exceeds 8 GB. Without this branch such a
 * member's size parses as garbage out of what are not octal digits — a wrong
 * number rather than a missing one, which is the same objection that made the
 * zip reader read the ZIP64 extra field.
 */
function base256Field(raw: Uint8Array): number | null {
  let value = (raw[0] ?? 0) & 0x7f;
  for (let i = 1; i < raw.length; i++) value = value * 256 + (raw[i] ?? 0);
  return Number.isSafeInteger(value) ? value : null;
}

function octalField(raw: Uint8Array): number | null {
  let value = 0;
  let digits = 0;
  for (const byte of raw) {
    // A field ends at its first NUL or space; both are used as terminators and
    // both are used as padding, which is why neither is an error.
    if (byte === 0 || byte === 0x20) break;
    if (byte < 0x30 || byte > 0x37) return null;
    value = value * 8 + (byte - 0x30);
    digits += 1;
  }
  return digits === 0 ? null : value;
}

function numericField(block: Uint8Array, at: number, width: number): number | null {
  const raw = block.subarray(at, at + width);
  // The high bit of the first byte is the flag that switches encodings.
  return ((raw[0] ?? 0) & 0x80) !== 0 ? base256Field(raw) : octalField(raw);
}

/**
 * Does this block's checksum verify?
 *
 * The stored checksum is the sum of every byte with the checksum field itself
 * read as eight spaces. **This is the whole sniff**: it is what distinguishes a
 * real tarball from `notes.txt.gz`, which is a legitimate file to land on and
 * which would otherwise render as a screenful of garbage names.
 *
 * Both the unsigned and the signed sum are accepted. The standard says
 * unsigned, but historic writers summed `char` as signed, and the two differ
 * only once a field holds a byte above 127 — which is exactly a non-ASCII
 * filename. Rejecting those would refuse real archives.
 */
function checksumMatches(block: Uint8Array): boolean {
  const stored = numericField(block, CHECKSUM_AT, CHECKSUM_WIDTH);
  if (stored === null) return false;

  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= CHECKSUM_AT && i < CHECKSUM_AT + CHECKSUM_WIDTH ? 0x20 : (block[i] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }

  return stored === unsigned || stored === signed;
}

interface TarHeader {
  readonly path: string;
  readonly size: number;
  readonly typeflag: number;
}

function parseHeader(block: Uint8Array, decodeText: DecodeText): TarHeader | null {
  if (!checksumMatches(block)) return null;

  const size = numericField(block, SIZE_AT, SIZE_WIDTH);
  if (size === null) return null;

  const name = field(block, NAME_AT, NAME_WIDTH, decodeText);
  const prefix = field(block, PREFIX_AT, PREFIX_WIDTH, decodeText);

  return {
    path: prefix === "" ? name : `${prefix}/${name}`,
    size,
    typeflag: block[TYPEFLAG_AT] ?? 0,
  };
}

/**
 * The records in a pax header, as bytes.
 *
 * Each record is `"<length> <key>=<value>\n"`, and **the length counts BYTES**,
 * including its own digits, the space and the newline. So this walks the raw
 * array rather than a decoded string: a value holding one non-ASCII character
 * makes the character count differ from the byte count, and every record after
 * it would then be read from the wrong offset.
 */
function parsePaxRecords(body: Uint8Array, decodeText: DecodeText): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;

  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;

    const length = decimalField(body.subarray(at, space));
    // A record must at least hold its own header, and must not run past the end.
    if (length === null || length <= space - at || at + length > body.length) break;

    // The trailing newline is part of the record and not part of the value.
    const text = decodeText(body.subarray(space + 1, at + length - 1));
    const equals = text.indexOf("=");
    if (equals > 0) records.set(text.slice(0, equals), text.slice(equals + 1));

    at += length;
  }

  return records;
}

/** A pax record's length prefix, which is decimal — unlike every tar field. */
function decimalField(raw: Uint8Array): number | null {
  let value = 0;
  let digits = 0;
  for (const byte of raw) {
    if (byte < 0x30 || byte > 0x39) return null;
    value = value * 10 + (byte - 0x30);
    digits += 1;
  }
  return digits === 0 ? null : value;
}

/** What the walk carries between blocks. Its own type so the loop stays flat. */
interface WalkState {
  readonly entries: ArchiveEntry[];
  /**
   * A path for the NEXT entry, from a GNU long-name block or a pax `path=`
   * record. One field for both, because an archive uses one mechanism or the
   * other and never both — so there is no precedence question to get wrong.
   */
  pendingPath: string | null;
  /** A size for the next entry, from a pax `size=` record. */
  pendingSize: number | null;
  zeroBlocks: number;
}

/** A GNU long-name block: its CONTENT is the next entry's path. */
async function takeLongName(
  stream: ByteStream,
  header: TarHeader,
  dataBlocks: number,
  state: WalkState,
  decodeText: DecodeText,
): Promise<boolean> {
  if (header.size > MAX_METADATA_BYTES) return false;

  const data = await stream.take(dataBlocks);
  if (data === null) return false;
  state.pendingPath = decodeText(data.subarray(0, header.size)).replace(/\0+$/, "");
  return true;
}

/**
 * A pax header: its records describe the entry that follows.
 *
 * NOT skipped, which is what an earlier version did and what verification
 * caught: the body carries the `path=` record that OVERRIDES the truncated
 * 100-byte ustar name field. bsdtar chooses pax by default once a name exceeds
 * that width, so discarding this silently corrupts long names in ordinary
 * archives rather than in exotic ones.
 */
async function takePaxHeader(
  stream: ByteStream,
  header: TarHeader,
  dataBlocks: number,
  state: WalkState,
  decodeText: DecodeText,
): Promise<boolean> {
  if (header.size > MAX_METADATA_BYTES) return false;

  const data = await stream.take(dataBlocks);
  if (data === null) return false;

  const records = parsePaxRecords(data.subarray(0, header.size), decodeText);
  state.pendingPath = records.get("path") ?? state.pendingPath;

  const declared = records.get("size");
  const parsed = declared === undefined ? Number.NaN : Number(declared);
  if (Number.isSafeInteger(parsed) && parsed >= 0) state.pendingSize = parsed;

  return true;
}

/** An ordinary member: record it, then step over its data. */
async function takeEntry(
  stream: ByteStream,
  header: TarHeader,
  dataBlocks: number,
  state: WalkState,
): Promise<boolean> {
  const path = state.pendingPath ?? header.path;
  const size = state.pendingSize ?? header.size;
  state.pendingPath = null;
  state.pendingSize = null;

  const isDirectory = header.typeflag === TYPE_DIRECTORY || path.endsWith("/");
  state.entries.push({ path, size: isDirectory ? 0 : size, isDirectory });

  // `dataBlocks` comes from the HEADER's size, and that is load-bearing: a pax
  // `size=` record describes the member, not the blocks on disk, so stepping by
  // it would desynchronise the walk from the next header.
  return stream.skip(dataBlocks);
}

/** What a header asks the walk to do. `false` means the archive has ended. */
function applyHeader(
  stream: ByteStream,
  header: TarHeader,
  state: WalkState,
  decodeText: DecodeText,
): Promise<boolean> {
  const dataBlocks = roundUpToBlock(header.size);

  switch (header.typeflag) {
    case TYPE_GNU_LONG_NAME:
      return takeLongName(stream, header, dataBlocks, state, decodeText);
    case TYPE_PAX_ENTRY:
      return takePaxHeader(stream, header, dataBlocks, state, decodeText);
    // `K` is a long LINK target, which nothing here shows, and `g` is a global
    // pax header, which in practice carries a comment rather than a path.
    case TYPE_GNU_LONG_LINK:
    case TYPE_PAX_GLOBAL:
      return stream.skip(dataBlocks);
    default:
      return takeEntry(stream, header, dataBlocks, state);
  }
}

/**
 * One block, applied to the walk. `false` means the archive has ended.
 *
 * Returns rather than throws for every ending — a corrupt archive is an
 * ordinary thing to land the cursor on.
 */
async function consumeBlock(
  stream: ByteStream,
  block: Uint8Array,
  state: WalkState,
  decodeText: DecodeText,
): Promise<boolean> {
  if (isZeroBlock(block)) {
    state.zeroBlocks += 1;
    // Two in a row is how a tar says it is over. One alone is padding some
    // writers emit, so it is not enough on its own.
    return state.zeroBlocks < 2;
  }
  state.zeroBlocks = 0;

  const header = parseHeader(block, decodeText);
  // Trailing rubbish after a well-formed run of entries. Stop with what is
  // already collected; the first-block case is `notAnArchive` and is decided
  // by the caller, which is the only place that knows a block is the first.
  if (header === null) return false;

  return applyHeader(stream, header, state, decodeText);
}

/** Which bound ended the walk early, where either did. */
function stopReason(entries: number, pulled: number, limits: Required<TarLimits>): TarStop {
  if (entries >= limits.maxEntries) return "cap";
  if (pulled >= limits.maxBytes) return "ceiling";
  return null;
}

/** Are these first bytes something that was never a tar at all? */
function firstBlockRejects(block: Uint8Array, decodeText: DecodeText): boolean {
  return !isZeroBlock(block) && parseHeader(block, decodeText) === null;
}

/**
 * List a tar's members from a stream of its bytes.
 *
 * `decodeText` is a parameter for the reason `types.ts` gives: this package has
 * no `TextDecoder`. The caller in the panel supplies a real one; the tests
 * supply `String.fromCharCode`.
 */
export async function readTarIndex(
  chunks: AsyncIterable<Uint8Array>,
  decodeText: DecodeText,
  limits: TarLimits = {},
): Promise<TarIndex> {
  const bounds: Required<TarLimits> = {
    maxEntries: limits.maxEntries ?? MAX_ARCHIVE_ENTRIES,
    maxBytes: limits.maxBytes ?? MAX_TAR_BYTES,
  };

  const stream = byteStream(chunks, bounds.maxBytes);
  const state: WalkState = { entries: [], pendingPath: null, pendingSize: null, zeroBlocks: 0 };
  let first = true;

  try {
    while (stopReason(state.entries.length, stream.pulled(), bounds) === null) {
      const block = await stream.take(BLOCK);

      // The one place a bad block means "these bytes were never a tar" rather
      // than "the tar ends here". Only the caller knows which block is first.
      // A stream ending before one whole block counts: verification named a
      // short gzipped text file answering "an empty archive", which is a
      // different and less honest claim than "not an archive".
      if (block === null || (first && firstBlockRejects(block, decodeText))) {
        // Only bytes that genuinely ran out mean "never a tar". A first read
        // cut short by the ceiling is a listing that stopped, and saying
        // otherwise would turn a bound into an accusation.
        const bounded = stopReason(state.entries.length, stream.pulled(), bounds) !== null;
        if (first && !bounded) return { kind: "notAnArchive" };
        break;
      }
      first = false;

      if (!(await consumeBlock(stream, block, state, decodeText))) break;
    }
  } finally {
    await stream.close();
  }

  return {
    kind: "index",
    entries: state.entries,
    stopped: stopReason(state.entries.length, stream.pulled(), bounds),
  };
}
