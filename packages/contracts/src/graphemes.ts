import { countGraphemes as countUnicodeGraphemes } from "unicode-segmenter/grapheme";

// Hermes lacks Intl.Segmenter. Use Unicode grapheme boundaries there without
// installing a global polyfill or changing segmentation on other runtimes.
const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function countGraphemes(text: string): number {
  if (!segmenter) return countUnicodeGraphemes(text);
  let count = 0;
  for (const _segment of segmenter.segment(text)) count += 1;
  return count;
}
