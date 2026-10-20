/** @vitest-environment happy-dom */

import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OverviewModel } from "../../src/overview/useOverview.ts";
import { FileTree } from "../../src/tree/FileTree.tsx";
import type { TreeRecord } from "../../src/tree/state.ts";
import type { TreePort } from "../../src/tree/useTreeMode.ts";
import { treeEntry } from "./tree-support.ts";

/**
 * What the tree's width costs when its rows are projected again.
 *
 * Entry point: `FileTree`, mounted the way a host mounts it (Mesura Code's file
 * panel, `MesuraFileTree.tsx`). `useTreeWidth` measures every row's name with
 * canvas `measureText` in a layout effect whenever `rows` changes, and `rows`
 * is projected again whenever the host hands the tree a new `folders` map. A
 * host that refetches its listing after every save — Mesura Code does, on each
 * write its editor makes — then pays one `measureText` per row per save, before
 * paint: 129 to 242 ms long tasks on a project of a few hundred rows.
 *
 * DOM-only environments have no canvas text metrics, so the canvas is replaced
 * by one that counts its measurements and answers 7 px per character.
 */

const ROOT = "/home/jc";
const FILE_COUNT = 300;

let measured: string[] = [];

/**
 * The page's font set as a browser has it once fonts finished loading: status
 * `loaded`, `ready` already resolved, and `loadingdone` dispatched when a font
 * loads later. happy-dom has none.
 */
function installLoadedFontSet(): EventTarget {
  const fonts = Object.assign(new EventTarget(), { status: "loaded" as FontFaceSetLoadStatus });
  Object.defineProperty(fonts, "ready", { value: Promise.resolve(fonts) });
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  return fonts;
}

let fonts: EventTarget;

beforeEach(() => {
  measured = [];
  fonts = installLoadedFontSet();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        letterSpacing: "",
        measureText: (text: string) => {
          measured.push(text);
          return { width: text.length * 7 };
        },
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "fonts");
});

function fileNames(extra: readonly string[] = []): string[] {
  return [
    ...Array.from(
      { length: FILE_COUNT },
      (_, index) => `file-${String(index).padStart(3, "0")}.ts`,
    ),
    ...extra,
  ];
}

/**
 * A listing as a host builds it from a fresh fetch: new `Map`, new folder and
 * entry objects every time, equal in content when nothing on disk changed.
 */
function listing(names: readonly string[]): OverviewModel {
  const root: OverviewFolder = {
    path: ROOT,
    depth: 0,
    entries: names.map((name) => treeEntry(name)),
    status: "Loaded",
  };
  return {
    folders: new Map([[ROOT, root]]),
    loading: false,
    inspected: names.length,
    include: () => undefined,
  };
}

function record(): TreeRecord {
  return {
    shape: { selected: ROOT, collapsed: new Set(), preset: null, checkpoint: null },
    anchor: null,
    pendingReveal: null,
  };
}

const port: TreePort = { connect: () => () => undefined, select: () => undefined };

function mountTree(model: OverviewModel, treeRecord: TreeRecord) {
  return render(
    <FileTree
      root={ROOT}
      model={model}
      port={port}
      record={treeRecord}
      onOpen={() => undefined}
      autoFocus={false}
    />,
  );
}

/**
 * Lets a font-readiness callback run, as it does in a browser where the fonts
 * finished loading long ago: `document.fonts.ready` is already resolved, and
 * its `then` callbacks run a microtask after the effect that registers them.
 */
async function afterFontsReady(): Promise<void> {
  await act(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function canvasMinWidth(): string {
  const canvas = document.querySelector<HTMLElement>(".file-tree .tree-canvas");
  if (!canvas) throw new Error("the tree rendered no canvas");
  return canvas.style.minWidth;
}

it("measures no row again when a refetch after a save hands the tree an equal listing", async () => {
  const treeRecord = record();
  const view = mountTree(listing(fileNames()), treeRecord);
  await afterFontsReady();
  expect(measured.length, "precondition: mounting measures the rows").toBeGreaterThanOrEqual(
    FILE_COUNT,
  );

  measured = [];
  view.rerender(
    <FileTree
      root={ROOT}
      model={listing(fileNames())}
      port={port}
      record={treeRecord}
      onOpen={() => undefined}
      autoFocus={false}
    />,
  );

  await afterFontsReady();

  expect(measured.length, `measureText calls after an equal listing of ${FILE_COUNT} rows`).toBe(0);
});

it("measures only the row that appeared when one file is added to a large listing", async () => {
  const treeRecord = record();
  const view = mountTree(listing(fileNames()), treeRecord);
  await afterFontsReady();

  measured = [];
  view.rerender(
    <FileTree
      root={ROOT}
      model={listing(fileNames(["added.ts"]))}
      port={port}
      record={treeRecord}
      onOpen={() => undefined}
      autoFocus={false}
    />,
  );

  await afterFontsReady();

  expect(measured, `measureText calls after one file joined ${FILE_COUNT} rows`).toEqual([
    "added.ts",
  ]);
});

it("widens the tree canvas when a file with the longest name appears", () => {
  // Guard: whatever the measurement saves, the width it produces stays right.
  const treeRecord = record();
  const view = mountTree(listing(fileNames()), treeRecord);
  const before = Number.parseFloat(canvasMinWidth());

  const longName = `${"a-very-long-name-".repeat(6)}.ts`;
  view.rerender(
    <FileTree
      root={ROOT}
      model={listing(fileNames([longName]))}
      port={port}
      record={treeRecord}
      onOpen={() => undefined}
      autoFocus={false}
    />,
  );

  const after = Number.parseFloat(canvasMinWidth());
  expect(after).toBeGreaterThan(before);
  // Padding, disclosure, icon and gaps (62) at depth 1 (14), then the name.
  expect(after).toBe(Math.ceil(62 + 14 + longName.length * 7));
});

it("measures every row again when a web font finishes loading", async () => {
  // Guard: a font that loads after the tree changes every width, so the cache
  // must go then, and only then.
  const treeRecord = record();
  mountTree(listing(fileNames()), treeRecord);
  await afterFontsReady();

  measured = [];
  await act(async () => {
    fonts.dispatchEvent(new Event("loadingdone"));
  });

  expect(measured.length, "measureText calls after a font loaded").toBeGreaterThanOrEqual(
    FILE_COUNT,
  );
});
