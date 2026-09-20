import { useCallback, useMemo, useState } from "react";

/**
 * Where a media element is, and how long its file is.
 *
 * ── Why this is not a plain pair of `useState` calls ────────────────────────
 * A preview component is NOT remounted when the cursor moves between two files
 * of the same kind — only its `path` prop changes — so ordinary state here
 * keeps the previous file's numbers and shows them beside the next file's name.
 * Verification caught that: a 122-second recording reported `0:00`.
 *
 * ── And why pairing each value with its URL was not enough ──────────────────
 * The first fix stored `{ url, seconds }` and used a value only when its URL
 * matched. That is correct for moving to a DIFFERENT file and wrong for coming
 * BACK to one. Verification caught that too: play a file, pause it, move away,
 * move back — the element reloads and resets `currentTime` to zero, while the
 * remembered position matched the URL again and the seek control sat at 1.48
 * seconds of a file playing from the start.
 *
 * The element's state is keyed on the LOAD, not on the address. Two visits to
 * one file are two loads sharing one URL, so this keeps a single record and
 * discards it whenever the URL changes — including changing back. Adjusting
 * state during render is React's own documented way to do that, and it is
 * deliberate rather than an effect: an effect would paint the stale value once
 * before clearing it.
 */
export interface MediaProgress {
  /** Seconds into the file currently loaded. Zero after any reload. */
  readonly position: number;
  /**
   * The file's length, or `null` when it is not known yet.
   *
   * `null` and not `0`, because `0:00` is a perfectly good answer for an empty
   * file and "I do not know" is not the same statement. The pane shows the
   * file's type instead, and disables the seek control.
   */
  readonly duration: number | null;
  readonly reportPosition: (seconds: number) => void;
  readonly reportDuration: (seconds: number) => void;
}

interface Track {
  /** The URL these numbers were measured against. */
  readonly url: string | null;
  readonly position: number;
  readonly duration: number | null;
}

const START: Track = { url: null, position: 0, duration: null };

/**
 * @param url the file these numbers describe, or `null` before one arrives.
 * @param taggedDuration what the metadata parser found, used only until the
 *   element reports its own. The parser is asked NOT to compute a duration —
 *   deriving one costs reading the whole file — so for most formats this is
 *   zero and the element is the only source.
 */
export function useMediaProgress(url: string | null, taggedDuration: number): MediaProgress {
  const [track, setTrack] = useState<Track>(START);

  // A new load. Everything measured against the old one is gone, and that
  // includes a return to a file this hook has already seen.
  if (track.url !== url) setTrack({ ...START, url });

  const reportPosition = useCallback((seconds: number) => {
    setTrack((current) => ({ ...current, position: seconds }));
  }, []);

  const reportDuration = useCallback((seconds: number) => {
    // A stream reports `Infinity` first and a real length later, if ever.
    if (!Number.isFinite(seconds)) return;
    setTrack((current) => ({ ...current, duration: seconds }));
  }, []);

  return useMemo(() => {
    // While the state is catching up with a URL change, report the new file's
    // starting values rather than the outgoing file's.
    const current = track.url === url ? track : START;
    const tagged = taggedDuration > 0 ? taggedDuration : null;

    return {
      position: current.position,
      // The element's own number wins whenever it has one: it is what the seek
      // control actually addresses.
      duration: current.duration ?? tagged,
      reportPosition,
      reportDuration,
    };
  }, [track, url, taggedDuration, reportPosition, reportDuration]);
}
