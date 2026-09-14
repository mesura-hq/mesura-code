import { expect, it } from "vitest";
import {
  minimapProjection,
  minimapWorldPoint,
  projectMinimapViewport,
} from "../src/overview/viewport.ts";

it("fits both map dimensions to the graph within viewport caps", () => {
  const wide = minimapProjection({ width: 2000, height: 1000 }, { width: 1200, height: 800 });
  expect(wide).toMatchObject({ width: 300, height: 158, scale: 0.142, offset: { x: 8, y: 8 } });
  const tall = minimapProjection({ width: 100, height: 10000 }, { width: 1200, height: 800 });
  expect(tall).toMatchObject({ width: 80, height: 240, scale: 0.0224 });
  expect(tall?.offset.x).toBeCloseTo(38.88);
});

it.each([
  { width: 1000, height: 2000, mapWidth: 128, mapHeight: 240 },
  { width: 2000, height: 1000, mapWidth: 300, mapHeight: 158 },
  { width: 1000, height: 1000, mapWidth: 240, mapHeight: 240 },
  { width: 10000, height: 100, mapWidth: 300, mapHeight: 80 },
])(
  "keeps compact $width × $height maps aligned for navigation",
  ({ width, height, mapWidth, mapHeight }) => {
    const projection = minimapProjection({ width, height }, { width: 1200, height: 800 });
    if (!projection) throw new Error("missing projection");
    expect(projection.width).toBeCloseTo(mapWidth);
    expect(projection.height).toBeCloseTo(mapHeight);
    const indicator = projectMinimapViewport(
      { x: width / 4, y: height / 4, width: width / 2, height: height / 2 },
      projection,
    );
    const center = minimapWorldPoint(
      { x: indicator.x + indicator.width / 2, y: indicator.y + indicator.height / 2 },
      projection,
    );
    expect(center.x).toBeCloseTo(width / 2);
    expect(center.y).toBeCloseTo(height / 2);
  },
);

it("clips the viewport to the graph and marks a viewport outside its bounds", () => {
  const projection = minimapProjection({ width: 2000, height: 1000 }, { width: 1200, height: 800 });
  if (!projection) throw new Error("missing projection");
  expect(
    projectMinimapViewport({ x: 100, y: 200, width: 400, height: 300 }, projection),
  ).toMatchObject({
    x: 22.2,
    y: 36.4,
    width: 56.8,
    height: expect.closeTo(42.6, 10),
    outside: false,
  });
  expect(
    projectMinimapViewport({ x: -100, y: -100, width: 4000, height: 3000 }, projection),
  ).toMatchObject({ x: 8, y: 8, width: 284, height: 142, outside: false });
  expect(
    projectMinimapViewport({ x: 2100, y: 1100, width: 100, height: 100 }, projection),
  ).toMatchObject({ x: 292, y: 150, outside: true });
});

it("withholds maps without available space and handles empty and tiny graphs", () => {
  expect(minimapProjection({ width: 1, height: 1 }, { width: 0, height: 0 })).toBeNull();
  expect(
    minimapProjection({ width: 0, height: 0 }, { width: 640, height: 480 })?.scale,
  ).toBeGreaterThan(0);
  const tiny = minimapProjection({ width: 10000, height: 1 }, { width: 100, height: 100 });
  expect(tiny).toMatchObject({ width: 25, height: 30 });
});
