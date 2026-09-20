import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { OverviewModel, OverviewPort } from "../src/overview/index.ts";
import type {
  TreeCommand,
  TreeController,
  TreePort,
  TreeRecord,
  TreeShape,
} from "../src/tree/index.ts";

/**
 * What a host imports.
 *
 * A host mounts the tree and the overview without the panel, so each needs a
 * subpath of its own in the package manifest and an index that names exactly
 * the surface the host is allowed to touch. Anything not re-exported here is
 * private to the panel and may change without a paired host commit.
 */

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { exports: Record<string, string> };

it("publishes the tree and the overview as subpaths", () => {
  expect(manifest.exports["./tree"]).toBe("./src/tree/index.ts");
  expect(manifest.exports["./overview"]).toBe("./src/overview/index.ts");
});

it("the tree index names the host surface", async () => {
  const tree = await import("../src/tree/index.ts");
  expect(typeof tree.FileTree).toBe("function");
  expect(typeof tree.useFlashPort).toBe("function");
});

it("the overview index names the host surface", async () => {
  const overview = await import("../src/overview/index.ts");
  expect(typeof overview.OverviewLayer).toBe("function");
});

it("the host surface type-checks", () => {
  const shape: TreeShape = {
    selected: "/home/jc",
    collapsed: new Set(),
    preset: null,
    checkpoint: null,
  };
  const record: TreeRecord = { shape, anchor: null, pendingReveal: null };
  const port: TreePort = { connect: () => () => undefined, select: () => undefined };
  const controller: TreeController = {
    command: () => undefined,
    reveal: () => undefined,
    cancel: () => undefined,
  };
  const command: TreeCommand = "down";
  const model: OverviewModel = {
    folders: new Map(),
    loading: false,
    inspected: 0,
    include: () => undefined,
  };
  const overviewPort: OverviewPort = {
    connect: () => () => undefined,
    reveal: () => undefined,
    focus: () => undefined,
  };
  expect(record.shape.selected).toBe("/home/jc");
  expect(typeof port.connect).toBe("function");
  expect(typeof controller.command).toBe("function");
  expect(command).toBe("down");
  expect(model.folders.size).toBe(0);
  expect(typeof overviewPort.reveal).toBe("function");
});
