/**
 * The two formatters more than one package has to agree on.
 *
 * `humanSize` began beside `PreviewPane`, moved down when the archive rows
 * needed it, and moved here when the finder's information panel became the
 * third caller — the file finder ships in its own package and must not import
 * the file-manager panel. Its own comment already stated the rule this move
 * follows: two copies of a formatter is how a listing and the notice below it
 * come to disagree about what a megabyte is.
 *
 * They live in the shared core because they are pure. No environment, no DOM,
 * no clock of their own — `humanAge` takes the present as an argument, so a
 * test does not have to freeze time to assert on it.
 */

const SIZE_UNITS = ["B", "kB", "MB", "GB", "TB"];

/** A size a person can read. */
export function humanSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** Each step, with how many milliseconds one of it takes. */
const AGE_STEPS: readonly (readonly [string, number])[] = [
  ["y", 365 * 24 * 60 * 60 * 1000],
  ["mo", 30 * 24 * 60 * 60 * 1000],
  ["d", 24 * 60 * 60 * 1000],
  ["h", 60 * 60 * 1000],
  ["m", 60 * 1000],
];

/**
 * How long ago something happened, in one coarse unit.
 *
 * One unit and not two: this is read at a glance beside three other facts, and
 * "3 months, 2 days ago" costs a row of the preview to say what "3mo ago" says.
 *
 * A timestamp of zero reads as unknown rather than as 1970. The engine reports
 * no modification time at all for a directory, so zero is the normal case there
 * and dating every folder to the Unix epoch would be a confident lie.
 */
export function humanAge(timestampMs: number, nowMs: number): string {
  if (timestampMs <= 0) return "—";
  const elapsed = nowMs - timestampMs;
  // A clock that disagrees with a file server, or a file written during a
  // leap-second smear, produces a modification time in the future. "in 4s ago"
  // is worse than admitting the file is new.
  if (elapsed < 0) return "just now";

  for (const [suffix, span] of AGE_STEPS) {
    if (elapsed >= span) return `${Math.floor(elapsed / span)}${suffix} ago`;
  }
  return "just now";
}
