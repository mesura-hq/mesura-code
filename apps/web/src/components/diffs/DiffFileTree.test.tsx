// @vitest-environment happy-dom
// Entry point: DiffFileTree for model guards. AppRoot.treeDiff.fence.test.tsx covers app wiring.
import type { CodeViewScrollTarget } from "@pierre/diffs";
import { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { act, type MouseEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FileDiffMetadata } from "@pierre/diffs";

import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { diffFileTreeEntries } from "./diffFileTree.logic";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";
import { focusPanelSurface } from "../../lib/panelSurfaceFocus";
import { makeFenceClientRects } from "../../test/appRootFenceMocks";

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
// Tooltip positioning is unrelated to the tree's actual model and activation path.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

const entries: DiffFileTreeEntry[] = [
  { path: "01-tall.ts", status: "modified" },
  { path: "02-short.ts", status: "modified" },
  { path: "03-medium.ts", status: "modified" },
];

class TreeRow {
  constructor(readonly path: string) {}

  getAttribute(name: string) {
    return name === "data-item-path" ? this.path : null;
  }
}

describe("diff tree file activation", () => {
  let renderer: ReactTestRenderer | undefined;
  const targets: CodeViewScrollTarget[] = [];
  const viewer = {
    getInstance: () => viewer,
    scrollTo: (target: CodeViewScrollTarget) => targets.push(target),
  };

  function Panel({
    files = entries,
    selectedPath = null,
  }: {
    files?: DiffFileTreeEntry[];
    selectedPath?: string | null;
  }) {
    const reveal = useCodeViewFileReveal(viewer, "working-tree");
    return (
      <DiffFileTree
        entries={files}
        ariaLabel="Working tree files"
        selectedPath={selectedPath}
        onSelectFile={(path) => reveal(`${path}\0${path}`)}
      />
    );
  }

  const model = (): FileTreeModel => renderer!.root.findByType(FileTree).props.model;

  async function mount(props: Parameters<typeof Panel>[0] = {}) {
    await act(async () => {
      renderer = create(<Panel {...props} />);
    });
  }

  // Exercise T3's capture handler before the real Pierre model's selection transition.
  // Only DOM hit testing is represented here; native pointer/keyboard dispatch and diff
  // geometry are verified separately in the integrated client.
  async function activate(path: string, modifiers: Partial<MouseEvent<HTMLElement>> = {}) {
    const event = {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      nativeEvent: { composedPath: () => [{}, new TreeRow(path), {}] },
      ...modifiers,
    } as MouseEvent<HTMLElement>;
    await act(async () => {
      renderer!.root
        .find((node) => String(node.type) === "file-tree-container")
        .props.onClickCapture?.(event);
      const tree = model();
      const item = tree.getItem(path)!;
      if (event.ctrlKey || event.metaKey) {
        item.toggleSelect();
      } else {
        for (const selected of tree.getSelectedPaths()) {
          if (selected !== path) tree.getItem(selected)?.deselect();
        }
        item.select();
      }
      item.focus();
      if ("toggle" in item && !event.ctrlKey && !event.metaKey && !event.shiftKey) item.toggle();
    });
  }

  beforeEach(() => {
    targets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("HTMLElement", TreeRow);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounts a file-to-symlink type change as one tree row", async () => {
    // Git carries a type change as a deletion and an addition of the same path.
    const typeChange = diffFileTreeEntries([
      { type: "deleted", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
      { type: "new", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
      { type: "change", name: "CLAUDE.md", prevName: "CLAUDE.md" } as FileDiffMetadata,
    ]);
    await mount({ files: [...typeChange] });

    const tree = model();
    expect(tree.getItem("AGENTS.md")?.isDirectory()).toBe(false);
    expect(tree.getItem("CLAUDE.md")?.isDirectory()).toBe(false);
    await activate("AGENTS.md");
    expect(targets).toEqual([{ type: "item", id: "AGENTS.md\u0000AGENTS.md", align: "start" }]);
  });

  it("reissues the reveal when the sole selected file is activated again", async () => {
    await mount();
    await activate("02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    await activate("02-short.ts");
    expect(targets).toEqual([
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
    ]);
  });

  it("reveals newly selected files once in either direction", async () => {
    await mount();
    await activate("02-short.ts");
    await activate("01-tall.ts");
    await activate("03-medium.ts");
    expect(targets.map((target) => ("id" in target ? target.id : null))).toEqual(
      ["02-short.ts", "01-tall.ts", "03-medium.ts"].map((path) => `${path}\0${path}`),
    );
  });

  it("keeps focus-only navigation separate from button activation", async () => {
    await mount();
    await activate("02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.focus());
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
    await activate("01-tall.ts", { detail: 0 });
    await activate("01-tall.ts", { detail: 0 });
    expect(targets).toHaveLength(3);
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "does not reveal a selected file that a %s click deselects",
    async (modifier) => {
      await mount();
      await activate("02-short.ts");
      await activate("02-short.ts", { [modifier]: true });
      expect(model().getSelectedPaths()).toEqual([]);
      expect(targets).toHaveLength(1);
    },
  );

  it("lets a click narrow multiple selected files without a second reveal", async () => {
    await mount();
    await activate("02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.select());
    expect(model().getSelectedPaths()).toHaveLength(2);
    targets.length = 0;
    await activate("02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
  });

  it("leaves directory selection and expansion to the tree", async () => {
    await mount({ files: [{ path: "src/app.ts", status: "modified" }] });
    const directory = model().getItem("src/")!;
    if (!("isExpanded" in directory)) throw new Error("Expected the directory handle");
    expect(directory.isExpanded()).toBe(true);
    await activate("src/");
    expect(directory.isExpanded()).toBe(false);
    await activate("src/");
    expect(directory.isExpanded()).toBe(true);
    expect(targets).toEqual([]);
  });

  it("reorders refreshed files without reopening a collapsed folder", async () => {
    const files: DiffFileTreeEntry[] = [
      { path: "src/state/shell.ts", status: "modified" },
      { path: "src/features/route.ts", status: "added" },
    ];
    await mount({ files });
    const initialFolder = model().getItem("src/features/")!;
    if (!("collapse" in initialFolder)) throw new Error("Expected the directory handle");
    await act(async () => initialFolder.collapse());
    await act(async () => {
      renderer!.update(<Panel files={[files[1]!, files[0]!]} />);
    });
    const folder = model().getItem("src/features/")!;
    if (!("isExpanded" in folder)) throw new Error("Expected the directory handle");
    expect(folder.isExpanded()).toBe(false);
  });

  it("does not echo controlled selection, but lets the reader activate it", async () => {
    await mount({ selectedPath: "02-short.ts" });
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toEqual([]);
    await activate("02-short.ts");
    expect(targets).toHaveLength(1);
    await act(async () => {
      renderer!.update(<Panel selectedPath="03-medium.ts" />);
    });
    expect(model().getSelectedPaths()).toEqual(["03-medium.ts"]);
    expect(targets).toHaveLength(1);
  });
});

describe("diff tree decoration refresh guards", () => {
  let root: Root;
  let container: HTMLDivElement;
  const files: DiffFileTreeEntry[] = [
    { path: "src/app.ts", status: "modified" },
    { path: "docs/README.md", status: "modified" },
  ];
  const onSelectFile = () => {};

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
      this: HTMLElement,
    ) {
      return makeFenceClientRects([this.getBoundingClientRect()]);
    });
    container = document.createElement("div");
    container.setAttribute("data-right-panel-surface-content", "");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderDecoration(renderFileDecoration: (path: string) => { text: string } | null) {
    await act(async () => {
      root.render(
        <DiffFileTree
          entries={files}
          ariaLabel="Decoration refresh files"
          onSelectFile={onSelectFile}
          renderFileDecoration={renderFileDecoration}
        />,
      );
    });
  }

  it("DiffFileTree decoration guard: count-only updates preserve the model, selection, collapsed folders and keyboard entry", async () => {
    const render = vi.spyOn(FileTreeModel.prototype, "render");
    await renderDecoration(() => ({ text: "+9 −2" }));
    const model = render.mock.contexts[0];
    if (!(model instanceof FileTreeModel)) throw new Error("Expected the mounted Pierre model");
    const host = model.getFileTreeContainer()!;
    const shadow = host.shadowRoot!;
    const scroller = shadow.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")!;
    const directory = model.getItem("docs/")!;
    if (!("collapse" in directory)) throw new Error("Expected the directory handle");
    await act(async () => {
      directory.collapse();
      model.getItem("src/app.ts")!.select();
      model.getItem("src/app.ts")!.focus();
    });
    const row = shadow.querySelector<HTMLElement>('[data-item-path="src/app.ts"]')!;
    expect(row.querySelector('[data-item-section="decoration"]')?.textContent).toBe("+9 −2");
    scroller.scrollTop = 20;

    await renderDecoration(() => ({ text: "+10 −2" }));

    expect(render.mock.contexts.every((current) => current === model)).toBe(true);
    expect(model.getFileTreeContainer()).toBe(host);
    expect(shadow.querySelector("[data-file-tree-virtualized-scroll]")).toBe(scroller);
    expect(scroller.scrollTop).toBe(20);
    expect(shadow.querySelector('[data-item-path="src/app.ts"]')).toBe(row);
    expect(row.querySelector('[data-item-section="decoration"]')?.textContent).toBe("+10 −2");
    expect(model.getSelectedPaths()).toEqual(["src/app.ts"]);
    expect(model.getFocusedPath()).toBe("src/app.ts");
    expect(directory.isExpanded()).toBe(false);
    expect(shadow.querySelector('[data-item-path="docs/README.md"]')).toBeNull();
    expect(focusPanelSurface(document.body)).toBe(true);
    expect(shadow.activeElement).toBe(row);
  });

  it("DiffFileTree decoration guard: unchanged renderers do not redraw and removing a renderer clears counts", async () => {
    const decoration = vi.fn(() => ({ text: "+9 −2" }));
    await renderDecoration(decoration);
    const calls = decoration.mock.calls.length;
    await renderDecoration(decoration);
    expect(decoration.mock.calls.length).toBe(calls);

    await act(async () => {
      root.render(
        <DiffFileTree
          entries={files}
          ariaLabel="Decoration refresh files"
          onSelectFile={onSelectFile}
        />,
      );
    });
    const shadow = container.querySelector("file-tree-container")!.shadowRoot!;
    expect(shadow.querySelector('[data-item-path="src/app.ts"]')?.textContent).not.toContain(
      "+9 −2",
    );
  });
});
