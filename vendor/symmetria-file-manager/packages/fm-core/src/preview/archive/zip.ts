import type { ArchiveEntry, ByteSource } from "./types.ts";

/**
 * A zip's index, read from the end of the file.
 *
 * ── Why this is cheap and the tar reader is not ─────────────────────────────
 * A zip carries a complete index — the central directory — and a record at the
 * very end saying where it is. So listing a 1.5 GB archive is two reads: the
 * tail, then the directory the tail points at. Nothing else is ever fetched,
 * and `zip.test.ts` asserts the byte total rather than trusting this paragraph.
 *
 * Everything here is little-endian, which is the format's own convention.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_LENGTH = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_LENGTH = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LENGTH = 56;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_LENGTH = 46;

/**
 * The most the end record can sit behind the archive's last byte.
 *
 * Its own 22 bytes plus a comment field of at most 65535, which is what a
 * 16-bit length can express.
 */
const MAX_TAIL = EOCD_LENGTH + 0xffff;

/** A value a 32-bit field uses to say "the real one is in the ZIP64 record". */
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

/** Bit 13 of the general purpose flag: the central directory is encrypted too. */
const FLAG_STRONG_ENCRYPTION = 0x2000;

/** The extra field that carries a member's real size when 32 bits cannot. */
const ZIP64_EXTRA_ID = 0x0001;

export type ZipFailure =
  /** No end record, or fewer bytes than one. Also an empty file. */
  | "not-a-zip"
  /** The index the end record points at is not inside the archive. */
  | "truncated"
  /** Bit 13: even the names are encrypted, so there is nothing to list. */
  | "encrypted-index"
  /** A well-formed archive this reader will not follow — see `readZip64End`. */
  | "unsupported"
  /**
   * The archive contradicts itself: a member declared a size it then did not
   * supply. Distinct from `truncated`, where the bytes are missing rather than
   * the description of them.
   */
  | "malformed";

export type ZipIndex =
  | { readonly kind: "index"; readonly entries: readonly ArchiveEntry[] }
  | { readonly kind: "unreadable"; readonly reason: ZipFailure };

function unreadable(reason: ZipFailure): ZipIndex {
  return { kind: "unreadable", reason };
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * A 64-bit field as a number, or `null` when it will not fit one.
 *
 * A zip declaring an offset past `Number.MAX_SAFE_INTEGER` is not an archive
 * anybody has; treating it as `unsupported` is honest, whereas letting the
 * double silently round would send the next read to the wrong address.
 */
function safeU64(view: DataView, offset: number): number | null {
  const value = view.getBigUint64(offset, true);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

/** Where the archive's end record sits inside `tail`, or `null`. */
function findEndRecord(tail: Uint8Array): number | null {
  const view = viewOf(tail);

  // Backwards, because the record is at the END. And with the comment length
  // checked, because backwards alone is NOT enough: the comment follows the
  // record, so a signature occurring inside a comment is found FIRST by a
  // backwards scan. Requiring the declared comment length to account for
  // exactly the bytes that remain is what tells the two apart, and
  // `zip.test.ts` plants that trap on purpose.
  for (let at = tail.length - EOCD_LENGTH; at >= 0; at--) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(at + 20, true);
    if (at + EOCD_LENGTH + commentLength === tail.length) return at;
  }

  return null;
}

/** Where the index is and how many entries it holds. */
interface Directory {
  readonly offset: number;
  readonly size: number;
  readonly count: number;
}

/**
 * Tagged, rather than the `Directory | ZipFailure` it reads more directly as.
 *
 * That plainer union forced the caller to discriminate with
 * `typeof resolved === "string"` — asking about a JavaScript representation to
 * learn a domain fact, which stops being safe the day `Directory` gains a
 * string member. The anti-slop `no-runtime-typeof` rule flagged exactly it.
 */
type Zip64End =
  | { readonly kind: "directory"; readonly directory: Directory }
  | { readonly kind: "failure"; readonly reason: ZipFailure };

function failed64(reason: ZipFailure): Zip64End {
  return { kind: "failure", reason };
}

/**
 * The ZIP64 end record's three numbers, or `null` for a record this reader
 * will not follow — a wrong signature, or a value past `Number.MAX_SAFE_INTEGER`.
 *
 * Split out of `readZip64End` because that function was carrying two jobs and
 * fallow scored it accordingly: locating the record is I/O and bounds, parsing
 * it is neither.
 */
function parseZip64Record(record: Uint8Array): Directory | null {
  const view = viewOf(record);
  if (view.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) return null;

  const count = safeU64(view, 32);
  const size = safeU64(view, 40);
  const offset = safeU64(view, 48);
  if (count === null || size === null || offset === null) return null;

  return { count, size, offset };
}

/**
 * The ZIP64 records, which sit immediately before the classic one.
 *
 * Reached only when a classic field carries its sentinel, which is how an
 * archive says the real value did not fit in 32 bits.
 */
async function readZip64End(
  source: ByteSource,
  tail: Uint8Array,
  endAt: number,
): Promise<Zip64End> {
  const locatorAt = endAt - ZIP64_LOCATOR_LENGTH;
  if (locatorAt < 0) return failed64("truncated");

  const tailView = viewOf(tail);
  if (tailView.getUint32(locatorAt, true) !== ZIP64_LOCATOR_SIGNATURE)
    return failed64("unsupported");

  const recordAt = safeU64(tailView, locatorAt + 8);
  if (recordAt === null || recordAt + ZIP64_EOCD_LENGTH > source.size) return failed64("truncated");

  const record = await source.read(recordAt, ZIP64_EOCD_LENGTH);
  if (record.length < ZIP64_EOCD_LENGTH) return failed64("truncated");

  const directory = parseZip64Record(record);
  return directory === null ? failed64("unsupported") : { kind: "directory", directory };
}

/**
 * A member's real uncompressed size, when 32 bits could not hold it.
 *
 * The ZIP64 extra field packs only the values whose classic fields carry the
 * sentinel, in a fixed order — uncompressed, then compressed, then the local
 * header offset. So the uncompressed size, when present at all, is first.
 * Without this a six-gigabyte member reads as 4.0 GB, which is a wrong number
 * presented as a fact rather than a missing one.
 *
 * `null` means the sentinel was there and the real value was not, which makes
 * the archive self-contradictory rather than merely large. The caller refuses
 * it. An earlier version substituted the sentinel here instead — reporting the
 * exact 4.0 GB this function exists to prevent, three lines below the sentence
 * saying so. Do not reinstate that fallback.
 */
function zip64Size(extra: Uint8Array): number | null {
  const view = viewOf(extra);
  let at = 0;

  while (at + 4 <= extra.length) {
    const id = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (at + 4 + length > extra.length) return null;
    if (id === ZIP64_EXTRA_ID && length >= 8) return safeU64(view, at + 4);
    at += 4 + length;
  }

  return null;
}

/** Walk the central directory, one fixed header plus three variable fields at a time. */
function parseDirectory(source: ByteSource, directory: Uint8Array, count: number): ZipIndex {
  const view = viewOf(directory);
  const entries: ArchiveEntry[] = [];
  let at = 0;

  while (entries.length < count) {
    if (at + CENTRAL_HEADER_LENGTH > directory.length) return unreadable("truncated");
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) return unreadable("truncated");

    const flag = view.getUint16(at + 8, true);
    // Checked per entry rather than once, because an archive may encrypt some
    // members and not others, and one strongly encrypted member means the
    // names around it cannot be trusted either.
    if ((flag & FLAG_STRONG_ENCRYPTION) !== 0) return unreadable("encrypted-index");

    const declaredSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);

    const nameAt = at + CENTRAL_HEADER_LENGTH;
    const extraAt = nameAt + nameLength;
    const next = extraAt + extraLength + commentLength;
    if (next > directory.length) return unreadable("truncated");

    const path = source.decodeText(directory.subarray(nameAt, extraAt));
    // The format's own convention, and the only one it has: a member whose
    // name ends in a separator IS the folder.
    const isDirectory = path.endsWith("/");

    const size =
      declaredSize === ZIP64_SENTINEL_32
        ? zip64Size(directory.subarray(extraAt, extraAt + extraLength))
        : declaredSize;
    if (size === null) return unreadable("malformed");

    entries.push({ path, size: isDirectory ? 0 : size, isDirectory });
    at = next;
  }

  return { kind: "index", entries };
}

/**
 * List an archive's members without reading the archive.
 *
 * Never throws: a corrupt or hostile file is an ordinary thing to land the
 * cursor on, so every failure is a value the pane can draw a notice from.
 */
export async function readZipIndex(source: ByteSource): Promise<ZipIndex> {
  if (source.size < EOCD_LENGTH) return unreadable("not-a-zip");

  const tailLength = Math.min(source.size, MAX_TAIL);
  const tail = await source.read(source.size - tailLength, tailLength);

  const endAt = findEndRecord(tail);
  if (endAt === null) return unreadable("not-a-zip");

  const tailView = viewOf(tail);
  const classic: Directory = {
    count: tailView.getUint16(endAt + 10, true),
    size: tailView.getUint32(endAt + 12, true),
    offset: tailView.getUint32(endAt + 16, true),
  };

  const needsZip64 =
    classic.count === ZIP64_SENTINEL_16 ||
    classic.size === ZIP64_SENTINEL_32 ||
    classic.offset === ZIP64_SENTINEL_32;

  let directory = classic;
  if (needsZip64) {
    const resolved = await readZip64End(source, tail, endAt);
    if (resolved.kind === "failure") return unreadable(resolved.reason);
    directory = resolved.directory;
  }

  if (directory.offset + directory.size > source.size) return unreadable("truncated");
  if (directory.count === 0) return { kind: "index", entries: [] };

  const bytes = await source.read(directory.offset, directory.size);
  return parseDirectory(source, bytes, directory.count);
}
