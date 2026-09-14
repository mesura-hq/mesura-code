import { parseBlob } from "music-metadata";

/**
 * Tags and cover art, off the interface thread.
 *
 * Modelled on `highlight.worker.ts`, and the discipline is the same one: a
 * request carries an id, the answer carries it back, and the consumer drops any
 * answer whose id is not the current one. The preview is debounced by 150 ms
 * and the cursor keeps moving, so an answer for the previous file arriving
 * after the next one is on screen is the normal case rather than the corner.
 *
 * **Tags are decoration.** Every failure below returns an EMPTY answer rather
 * than an error: a file whose tag block is corrupt still plays, and a pane that
 * refuses to draw because it could not read a title has turned a cosmetic
 * problem into a functional one. `CodePreview` treats highlighting the same
 * way, for the same reason.
 *
 * It fetches the file itself rather than being handed bytes. The token URL is
 * same-origin and the app scheme is registered with `supportFetchAPI`, so a
 * worker created from that document can fetch it — and that keeps a whole
 * audio file from crossing the boundary twice.
 */

export interface TagsRequest {
  readonly id: number;
  /** The token URL the main process issued for this file. */
  readonly url: string;
}

/** A cover picture, as bytes plus the type needed to build a blob from them. */
export interface TagsPicture {
  readonly bytes: ArrayBuffer;
  readonly mime: string;
}

export interface TagsResponse {
  readonly id: number;
  /** Empty when the file carries none — the pane falls back to the filename. */
  readonly title: string;
  readonly artist: string;
  /** Zero when unknown. The element's own `duration` is the better source. */
  readonly durationSeconds: number;
  readonly picture: TagsPicture | null;
}

/**
 * How much of a file's HEAD the parser is allowed to look at first.
 *
 * ID3v2, FLAC and Ogg all put their tag block — cover art included — at the
 * front, so for those this is the whole cost. Reading the whole of a 300 MB
 * lossless file to find a title would cost more than every other part of the
 * preview together.
 */
const TAG_BYTES = 2 * 1024 * 1024;

/**
 * When the head is not enough, and how much more is worth reading.
 *
 * **MP4 and M4A are the exception the head-slice rule misses**, and review
 * caught it: their metadata lives in the `moov` atom, which sits at the END of
 * any file not written with `faststart`. That is a common, ordinary file rather
 * than a corrupt one, and it would have shown no title and no cover art while
 * looking exactly like a file that simply carries neither.
 *
 * So a head read that finds NOTHING is retried over the whole file — but only
 * below this size, because the retry is the expensive path and an unbounded one
 * would trade a missing title for a stalled pane. Above it the gap stands, and
 * a file that large is a recording rather than a tagged track.
 */
const WHOLE_FILE_LIMIT = 64 * 1024 * 1024;

const EMPTY = { title: "", artist: "", durationSeconds: 0, picture: null } as const;

/** What one parse found, or `null` when the bytes yielded nothing at all. */
async function parseFrom(blob: Blob): Promise<Omit<TagsResponse, "id"> | null> {
  const metadata = await parseBlob(blob, { duration: false });
  const picture = metadata.common.picture?.[0];
  const title = metadata.common.title ?? "";
  const artist = metadata.common.artist ?? "";

  // Nothing worth showing. The caller decides whether that is the answer or
  // whether it is worth looking further into the file.
  if (title === "" && artist === "" && picture === undefined) return null;

  return {
    title,
    artist,
    durationSeconds: metadata.format.duration ?? 0,
    picture:
      picture === undefined
        ? null
        : {
            // A fresh copy, because the parser's view may be a slice of a
            // larger buffer and transferring that would send the whole thing.
            bytes: picture.data.slice().buffer,
            mime: picture.format,
          },
  };
}

/** The whole resource's length, from a range answer's `content-range`. */
export function totalSizeOf(response: Response): number | null {
  const range = response.headers.get("content-range");
  const total = range === null ? null : /\/(\d+)$/.exec(range)?.[1];
  if (total !== undefined && total != null) return Number(total);

  // A 200 answers with the whole thing, so its own length is the total.
  const length = response.headers.get("content-length");
  return length === null ? null : Number(length);
}

async function readTags(request: TagsRequest): Promise<TagsResponse> {
  try {
    // A range request, which the preview scheme answers — see
    // `app/src/main/fileRange.ts`. A server that ignored it would hand back the
    // whole file and this would still work, only slower.
    const head = await fetch(request.url, { headers: { range: `bytes=0-${TAG_BYTES - 1}` } });
    if (!head.ok) return { id: request.id, ...EMPTY };

    const total = totalSizeOf(head);
    const fromHead = await parseFrom(await head.blob());
    if (fromHead !== null) return { id: request.id, ...fromHead };

    // The head said nothing. Either the file genuinely carries no tags, or its
    // metadata is at the other end — see `WHOLE_FILE_LIMIT`. One more read
    // settles it, and only when the head was not already the whole file.
    const truncated = total !== null && total > TAG_BYTES;
    if (!truncated || total > WHOLE_FILE_LIMIT) return { id: request.id, ...EMPTY };

    const whole = await fetch(request.url);
    if (!whole.ok) return { id: request.id, ...EMPTY };

    return { id: request.id, ...((await parseFrom(await whole.blob())) ?? EMPTY) };
  } catch {
    return { id: request.id, ...EMPTY };
  }
}

self.addEventListener("message", (event: MessageEvent<TagsRequest>) => {
  void readTags(event.data).then((answer) => {
    // Transfer the picture rather than copying it. A cover is commonly a
    // megabyte, and this pane sees one per audio file the cursor rests on.
    //
    // The options form rather than the positional one: this file is typed
    // against the DOM lib, where the three-argument `postMessage` belongs to
    // `Window` and wants an origin string second. Both spellings mean the same
    // thing to a real worker.
    self.postMessage(answer, { transfer: answer.picture === null ? [] : [answer.picture.bytes] });
  });
});
