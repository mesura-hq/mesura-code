import { FLASH_STATUS_LAYOUT } from "../overview/flashTargets.ts";
import type { useViewportFlash } from "./useViewportFlash.ts";

export function ViewportFlash({ flash }: { readonly flash: ReturnType<typeof useViewportFlash> }) {
  if (!flash.active) return null;
  const hint = flash.empty
    ? "No visible names"
    : flash.needsRefinement
      ? "Type more to separate labels"
      : flash.query
        ? flash.count === 0
          ? "No matching names"
          : "Type a label to jump"
        : "Type a name";
  return (
    <div className="overview-flash" data-flash-active="true">
      {flash.queries.map((query) => (
        <span
          key={query.path}
          className="overview-flash-match"
          aria-hidden="true"
          ref={(node) => {
            if (node) Object.assign(node.style, query.wrapping);
          }}
          style={{
            ...query.font,
            left: query.x,
            top: query.y,
            width: query.width,
            transform: `scale(${query.zoom})`,
            clipPath: query.clipPath,
          }}
        >
          {query.text}
        </span>
      ))}
      {flash.labels.map((label) => (
        <span
          key={label.path}
          className="overview-flash-label"
          data-flash-path={label.path}
          data-flash-label={label.label}
          style={{
            ...label.typography,
            left: label.x,
            top: label.y,
            padding: `0 ${label.typography.padding}px`,
          }}
        >
          <span className="overview-flash-prefix">{label.label.slice(0, flash.prefix.length)}</span>
          {label.label.slice(flash.prefix.length)}
        </span>
      ))}
      <div
        className="overview-flash-status"
        role="status"
        aria-label="Flash navigation"
        style={{
          left: FLASH_STATUS_LAYOUT.inset,
          bottom: FLASH_STATUS_LAYOUT.inset,
          width: FLASH_STATUS_LAYOUT.width,
          height: FLASH_STATUS_LAYOUT.height,
        }}
      >
        <strong>s</strong>{" "}
        <span className="overview-flash-query" title={flash.query}>
          {flash.query}
        </span>
        <span>{flash.count} matches</span>
        <span>{hint} · Esc cancels</span>
      </div>
    </div>
  );
}
