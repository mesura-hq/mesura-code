import { useLayoutEffect, useState } from "react";
import type { TreeRow } from "./model.ts";
import { isTreeDirectory } from "./model.ts";

/** Measure the complete projection so virtual unmounts cannot shrink scrollWidth. */
export function useTreeWidth(rows: readonly TreeRow[], viewport: HTMLElement | null) {
  const [width, setWidth] = useState(240);
  useLayoutEffect(() => {
    if (!viewport) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const name = viewport.querySelector<HTMLElement>(".tree-name");
      if (!name) return;
      const font = getComputedStyle(name);
      const canvas = document.createElement("canvas").getContext("2d");
      // DOM-only test environments have no canvas text metrics.
      if (!canvas) return;
      const textWidth = (text: string, size: string) => {
        canvas.font = `${font.fontStyle} ${font.fontWeight} ${size} ${font.fontFamily}`;
        canvas.letterSpacing = font.letterSpacing;
        return canvas.measureText(text).width;
      };
      setWidth(
        Math.ceil(Math.max(240, ...rows.map((row) => rowWidth(row, textWidth, font.fontSize)))),
      );
    };
    measure();
    void document.fonts?.ready.then(measure);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      active = false;
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [rows, viewport]);
  return width;
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
