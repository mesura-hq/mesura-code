import { useLayoutEffect, useRef, useState } from "react";
import type { TreeRow } from "./model.ts";
import { isTreeDirectory } from "./model.ts";

/**
 * Measure the complete projection so virtual unmounts cannot shrink scrollWidth.
 *
 * Text widths are cached per font and text, so a projection that is only
 * rebuilt — a host refetching an unchanged listing after every save — measures
 * nothing, and a listing that gained a row measures that row. Measuring every
 * row on every projection was a 129–242 ms layout task on a few hundred rows.
 *
 * The cache is dropped only when the fonts really change: a computed font that
 * differs, a `loadingdone`, or the initial `ready` while fonts were still
 * loading at mount. Those are followed once per viewport, not once per
 * projection: a `ready.then` registered on every rows change runs for every
 * listing update, long after the fonts loaded, and threw the cache away each
 * time.
 */
export function useTreeWidth(rows: readonly TreeRow[], viewport: HTMLElement | null) {
  const [width, setWidth] = useState(240);
  const measurerRef = useRef<TextMeasurer | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const measure = (fontsChanged: boolean) => {
    if (!viewport) return;
    const name = viewport.querySelector<HTMLElement>(".tree-name");
    if (!name) return;
    const font = getComputedStyle(name);
    const fontKey = `${font.fontStyle} ${font.fontWeight} ${font.fontFamily} ${font.letterSpacing}`;
    let measurer = measurerRef.current;
    if (measurer === null || fontsChanged || measurer.fontKey !== fontKey) {
      const context = document.createElement("canvas").getContext("2d");
      // DOM-only test environments have no canvas text metrics.
      if (!context) return;
      measurer = { fontKey, context, widths: new Map() };
      measurerRef.current = measurer;
    }
    const { context, widths } = measurer;
    const textWidth = (text: string, size: string) => {
      const key = `${size}\u0000${text}`;
      const cached = widths.get(key);
      if (cached !== undefined) return cached;
      const canvasFont = `${font.fontStyle} ${font.fontWeight} ${size} ${font.fontFamily}`;
      if (context.font !== canvasFont) context.font = canvasFont;
      if (context.letterSpacing !== font.letterSpacing) context.letterSpacing = font.letterSpacing;
      const measured = context.measureText(text).width;
      widths.set(key, measured);
      return measured;
    };
    let widest = 240;
    for (const row of rowsRef.current) {
      widest = Math.max(widest, rowWidth(row, textWidth, font.fontSize));
    }
    setWidth(Math.ceil(widest));
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;

  useLayoutEffect(() => {
    measureRef.current(false);
  }, [rows, viewport]);

  useLayoutEffect(() => {
    if (!viewport) return;
    const fonts = document.fonts;
    if (!fonts) return;
    let active = true;
    const remeasure = () => {
      if (active) measureRef.current(true);
    };
    if (fonts.status === "loading") void fonts.ready.then(remeasure);
    fonts.addEventListener("loadingdone", remeasure);
    return () => {
      active = false;
      fonts.removeEventListener("loadingdone", remeasure);
    };
  }, [viewport]);
  return width;
}

interface TextMeasurer {
  readonly fontKey: string;
  readonly context: CanvasRenderingContext2D;
  readonly widths: Map<string, number>;
}

function rowWidth(row: TreeRow, measure: (text: string, size: string) => number, fontSize: string) {
  // Padding 10+12, disclosure 14, icon 14, and two 6px gaps precede coverage.
  let width = 62 + row.depth * 14 + measure(row.name, fontSize);
  if (row.isSymlink) width += 6 + measure("↗ link", "12px");
  if (row.status !== "Loaded") width += 6 + measure(row.status, "12px");
  const pending = row.status === "Loading" || row.status === "Queued";
  if (isTreeDirectory(row) && row.status !== "Loaded" && !pending)
    width += 16 + measure(row.status.startsWith("Unreadable") ? "Retry" : "Include", "12px");
  return width;
}
