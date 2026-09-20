export function readFlashFont(source: CSSStyleDeclaration) {
  return {
    fontFamily: source.fontFamily,
    fontSize: source.fontSize,
    fontWeight: source.fontWeight,
    fontStyle: source.fontStyle,
    lineHeight: source.lineHeight,
    letterSpacing: source.letterSpacing,
  };
}

/** Cache font measurements within one captured scene, including query refinements. */
export function measureFlashTypography(
  font: ReturnType<typeof readFlashFont>,
  label: string,
  zoom: number,
  cache: Map<string, { width: number; height: number }>,
) {
  const key = JSON.stringify([font, label]);
  let rect = cache.get(key);
  if (!rect) {
    rect = measureLabel(font, label);
    cache.set(key, rect);
  }
  return {
    fontFamily: font.fontFamily,
    fontSize: `${Number.parseFloat(font.fontSize) * zoom}px`,
    fontWeight: font.fontWeight,
    fontStyle: font.fontStyle,
    letterSpacing:
      font.letterSpacing === "normal"
        ? "normal"
        : `${Number.parseFloat(font.letterSpacing) * zoom}px`,
    lineHeight: `${rect.height * zoom}px`,
    height: rect.height * zoom,
    width: rect.width * zoom + 4 * zoom,
    padding: 2 * zoom,
  };
}

function measureLabel(font: ReturnType<typeof readFlashFont>, label: string) {
  const probe = document.createElement("span");
  Object.assign(probe.style, font, {
    position: "fixed",
    visibility: "hidden",
    whiteSpace: "pre",
    pointerEvents: "none",
  });
  probe.textContent = label;
  document.body.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { width: rect.width, height: rect.height };
}
