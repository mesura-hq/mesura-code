/**
 * React keys for a list of strings that may repeat: the string itself, plus
 * its occurrence count once it has appeared before. Stable while the list is.
 */
export function occurrenceKeys(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const occurrence = seen.get(value) ?? 0;
    seen.set(value, occurrence + 1);
    return occurrence === 0 ? value : `${value}#${occurrence}`;
  });
}
