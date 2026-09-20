import { type Box, type GraphGroup, intersects } from "@symmetria/fm-core/overview/layout";
import { isAncestorPath } from "@symmetria/fm-core/overview/model";
export function OverviewLinks({
  shown,
  boxes,
  bounds,
  windowBox,
  zoom,
  selected,
}: {
  readonly shown: readonly GraphGroup[];
  readonly boxes: ReadonlyMap<string, GraphGroup>;
  readonly bounds: { width: number; height: number };
  readonly windowBox: Box;
  readonly zoom: number;
  readonly selected: string;
}) {
  return (
    <svg className="overview-links" width={bounds.width} height={bounds.height} aria-hidden="true">
      {shown.map((group) => {
        if (group.parent === null) return null;
        const parent = boxes.get(group.parent);
        if (!parent) return null;
        const x = parent.x + parent.width,
          y = parent.y + 20,
          ty = group.y + 20;
        if (
          !intersects(
            { x, y: Math.min(y, ty), width: group.x - x, height: Math.abs(y - ty) },
            windowBox,
            200 / zoom,
          )
        )
          return null;
        return (
          <g
            key={group.path}
            data-edge={group.path}
            className={
              isAncestorPath(group.path, selected) ? "overview-edge active" : "overview-edge"
            }
          >
            <path d={`M ${x} ${y} C ${x + 40} ${y}, ${group.x - 40} ${ty}, ${group.x} ${ty}`} />
            <circle cx={x} cy={y} r={3} />
            <circle cx={group.x} cy={ty} r={3} />
          </g>
        );
      })}
    </svg>
  );
}
