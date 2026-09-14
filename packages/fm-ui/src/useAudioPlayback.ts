import { useCallback, useMemo, useState } from "react";

/**
 * Which file the user asked to hear, if any.
 *
 * ── The state is a PATH, not a boolean ──────────────────────────────────────
 * The same trick the preview panes use for a failed decode. "Playing" stored as
 * a flag needs an effect to clear it when the cursor moves on, and an effect
 * that only clears a flag reads none of what it depends on — so it is written
 * once, forgotten, and the sound outlives the file. Comparing paths makes
 * "this request belongs to that file" the value itself, and moving to another
 * file stops the audio with no code at all.
 *
 * It lives above the pane because clearing it requires knowing where the cursor
 * is, and the pane is told only what to draw. Note the pane is NOT remounted
 * between two files of the same kind — a fact worth stating because assuming
 * otherwise is what left a previous file's length and playhead on screen beside
 * the next file's name.
 */
export interface AudioPlayback {
  /** Whether the file currently being previewed should be sounding. */
  readonly playing: boolean;
  /** What `Ctrl+P` calls. */
  readonly toggle: () => void;
}

/**
 * @param cursorPath what the cursor is on now — the file a toggle applies to.
 * @param previewPath what the pane is actually showing, which lags by the
 *   150 ms debounce. Asking `playing` about the PREVIEW rather than the cursor
 *   is what stops a pane that has not caught up from sounding the wrong file.
 */
export function useAudioPlayback(
  cursorPath: string | null,
  previewPath: string | null,
): AudioPlayback {
  const [playingPath, setPlayingPath] = useState<string | null>(null);

  const toggle = useCallback(() => {
    setPlayingPath((current) => (current === cursorPath ? null : cursorPath));
  }, [cursorPath]);

  // Memoised because `useKeyActions` memoises its action table on the identity
  // of what it is handed, and a fresh object every render would defeat it.
  return useMemo(
    () => ({ playing: playingPath !== null && playingPath === previewPath, toggle }),
    [playingPath, previewPath, toggle],
  );
}
