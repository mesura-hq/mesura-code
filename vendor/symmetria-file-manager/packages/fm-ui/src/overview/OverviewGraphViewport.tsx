import type { Box, GraphGroup } from "@symmetria/fm-core/overview/layout";
import type { ComponentProps, HTMLAttributes, RefObject } from "react";
import { FolderGroup } from "./FolderGroup.tsx";
import { OverviewLinks } from "./OverviewLinks.tsx";

type GroupActions = Pick<
  ComponentProps<typeof FolderGroup>,
  "onSelect" | "onToggle" | "onMeasure" | "onInclude"
>;
interface GraphViewportProps extends GroupActions {
  readonly viewport: RefObject<HTMLDivElement | null>;
  readonly extent: RefObject<HTMLDivElement | null>;
  readonly bounds: { width: number; height: number };
  readonly origin: { x: number; y: number };
  readonly zoom: number;
  readonly selected: string;
  readonly onScroll: () => void;
  readonly onWheel: () => void;
  readonly backgroundDrag: HTMLAttributes<HTMLDivElement>;
  readonly shown: readonly GraphGroup[];
  readonly boxes: ReadonlyMap<string, GraphGroup>;
  readonly windowBox: Box;
  readonly mounted: readonly GraphGroup[];
  readonly matches: ReadonlySet<string>;
  readonly collapsed: ReadonlySet<string>;
}
export function OverviewGraphViewport(props: GraphViewportProps) {
  const { viewport, extent, bounds, origin, zoom, selected, onScroll, onWheel, backgroundDrag } =
    props;
  return (
    <div
      ref={viewport}
      className="connected-groups"
      data-testid="connected-groups"
      data-zoom={zoom}
      data-selected={selected}
      onScroll={onScroll}
      onWheel={onWheel}
      {...backgroundDrag}
    >
      <div
        ref={extent}
        style={{
          width: bounds.width * zoom + origin.x + 24,
          height: bounds.height * zoom + origin.y + 24,
          overflow: "hidden",
        }}
      >
        <div
          className="overview-canvas"
          style={{
            width: bounds.width,
            height: bounds.height,
            transform: `translate(${origin.x}px, ${origin.y}px) scale(${zoom})`,
          }}
        >
          <OverviewLinks
            shown={props.shown}
            boxes={props.boxes}
            bounds={bounds}
            windowBox={props.windowBox}
            zoom={zoom}
            selected={selected}
          />
          {props.mounted.map((group) => (
            <FolderGroup
              key={group.path}
              group={group}
              selected={selected}
              matches={props.matches}
              collapsed={props.collapsed.has(group.path)}
              onSelect={props.onSelect}
              onToggle={props.onToggle}
              onMeasure={props.onMeasure}
              onInclude={props.onInclude}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
