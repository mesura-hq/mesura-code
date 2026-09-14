/**
 * A media length, and how much of one has played.
 *
 * Here rather than inside the audio pane. A formatter that lives inside its one
 * consumer is the shape that gets copied when a second arrives instead of
 * imported — the mistake `usePreviewUrl` was extracted out of, and the reason
 * three different `basename`s accumulated in this package. That second consumer
 * now EXISTS: `Waveform` imports `playedFraction` from here. An earlier version
 * of this paragraph called it planned, which stopped being true the moment the
 * waveform was written.
 *
 * `packages/fm-core` compiles against NO environment, so nothing here may
 * reach for `Intl`, `Date` or anything else the browser supplies.
 */

/**
 * Seconds as `m:ss`, or `h:mm:ss` once there are hours.
 *
 * Returns an EMPTY STRING for a length that is not one. A media element
 * reports `NaN` until it has metadata and `Infinity` for a stream, and both
 * would otherwise render as `NaN:aN` in the pane — which reads as a broken
 * application rather than as a fact not known yet.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";

  // Truncated, never rounded: a 9.9 second file that reads 0:10 has been
  // rounded past its own end, and the seek control beside it would disagree.
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;

  const paddedSeconds = String(remainder).padStart(2, "0");
  if (hours === 0) return `${minutes}:${paddedSeconds}`;

  // The minutes field is padded only once it stops being the leading one.
  // `1:05:00`, not `1:5:00`; and `3:35`, not `03:35`.
  return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
}

/**
 * How much of a file has been played, from 0 to 1.
 *
 * One line, and it exists because BOTH the waveform and the seek groove need
 * it and they must never disagree: they are drawn six pixels apart, so a
 * playhead computed one way beside a fill computed another is visible as a
 * misalignment. The three guards are the reason it is worth a name, and
 * duplicating them is how one copy ends up with `Infinity` for a width:
 *
 *   - an unknown length is `null`;
 *   - a zero length divides;
 *   - a non-finite POSITION poisons everything downstream. `useMediaProgress`
 *     filters a non-finite duration and deliberately does not filter a
 *     position, so `NaN` can arrive here. `Math.min(NaN, 1)` is `NaN`, which
 *     renders as the invalid inline style `width: NaN%` — dropped silently —
 *     and makes the waveform's `i < boundary` false for every bar, so a playing
 *     file draws as entirely unplayed. `Math.max` does not rescue it either.
 */
export function playedFraction(position: number, duration: number | null): number {
  if (duration === null || duration <= 0) return 0;
  if (!Number.isFinite(position) || position <= 0) return 0;
  // Clamped, because a media element can report a `currentTime` a hair past
  // its own `duration` at the very end of a file.
  return Math.min(position / duration, 1);
}
