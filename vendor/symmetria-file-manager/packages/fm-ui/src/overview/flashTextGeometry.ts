import type { FlashMatch } from "@symmetria/fm-core/flash";
import type { FlashScene } from "./flashTargets.ts";
import { readFlashFont } from "./flashTypography.ts";

/** Translate normalized match offsets before passing them to the original text node. */
function originalMatchOffsets(content: string, query: string) {
  const needle = query.toLowerCase();
  const normalizedStart = content.toLowerCase().indexOf(needle);
  if (!needle || normalizedStart < 0) return null;
  let normalizedOffset = 0;
  let originalOffset = 0;
  let start = 0;
  for (const character of content) {
    if (normalizedOffset <= normalizedStart) start = originalOffset;
    normalizedOffset += character.toLowerCase().length;
    originalOffset += character.length;
    if (normalizedOffset >= normalizedStart + needle.length) return { start, end: originalOffset };
  }
  return null;
}

function measureMatch(name: HTMLElement, query: string, zoom: number) {
  const text = name.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) return null;
  const content = text.textContent ?? "";
  const offsets = originalMatchOffsets(content, query);
  if (!offsets) return null;
  const range = document.createRange();
  range.setStart(text, offsets.start);
  range.setEnd(text, offsets.end);
  const fragments = [...range.getClientRects()];
  if (!fragments.some((rect) => rect.width > 0 && rect.height > 0)) return null;
  const box = name.getBoundingClientRect();
  // A union rectangle moved wrapped matches onto the first line. Keep each native line.
  const clipPath = fragments
    .map((rect) => {
      const left = (rect.left - box.left) / zoom;
      const top = (rect.top - box.top) / zoom;
      const right = (rect.right - box.left) / zoom;
      const bottom = (rect.bottom - box.top) / zoom;
      return `M ${left} ${top} H ${right} V ${bottom} H ${left} Z`;
    })
    .join(" ");
  const finalCharacter = [...content.slice(0, offsets.end)].at(-1) ?? "";
  range.setStart(text, offsets.end - finalCharacter.length);
  const last = range.getBoundingClientRect();
  range.setStart(text, 0);
  range.setEnd(text, [...content][0]?.length ?? 0);
  const first = range.getBoundingClientRect();
  const source = getComputedStyle(name);
  return {
    text: content,
    left: box.left,
    top: box.top,
    width: box.width / zoom,
    clipPath: `path("${clipPath}")`,
    endpoint: { left: last.right, top: box.top + last.top - first.top },
    font: readFlashFont(source),
    wrapping: {
      whiteSpace: source.whiteSpace,
      overflowWrap: source.overflowWrap,
      wordBreak: source.wordBreak,
      wordSpacing: source.wordSpacing,
    },
  };
}

export function measureFlashMatches(
  scene: FlashScene,
  matches: readonly FlashMatch[],
  query: string,
) {
  return matches.flatMap((match) => {
    const name = scene.names.get(match.path);
    const geometry = name && measureMatch(name, query, scene.zoom);
    return geometry
      ? [
          {
            ...geometry,
            path: match.path,
            zoom: scene.zoom,
            x: geometry.left - scene.left,
            y: geometry.top - scene.top,
          },
        ]
      : [];
  });
}
