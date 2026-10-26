import { FileTree as FileTreeModel } from "@pierre/trees";
import "../../index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, type Screen } from "../../../test/render";
import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { focusPanelSurface } from "../../lib/panelSurfaceFocus";
vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: (() => ({ resolvedTheme: "dark" })) as never,
}));
describe("diff tree decoration refresh guards", () => {
  let root: Screen;
  let container: HTMLDivElement;
  const files: DiffFileTreeEntry[] = [
    { path: "src/app.ts", status: "modified" },
    { path: "docs/README.md", status: "modified" },
    ...Array.from({ length: 30 }, (_, index) => ({
      path: `z-extra/file-${index}.ts`,
      status: "modified" as const,
    })),
  ];
  const onSelectFile = () => {};

  async function setupBrowserFixture0() {
    container = document.createElement("div");
    container.setAttribute("data-right-panel-surface-content", "");
    container.style.cssText = "display: flex; flex-direction: column; width: 360px; height: 160px";
    document.body.append(container);
    root = await render(null, { container, router: false });

    return {
      async [Symbol.asyncDispose]() {
        await act(async () => root.unmount());
        await root[Symbol.asyncDispose]();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      },
    };
  }

  async function renderDecoration(renderFileDecoration: (path: string) => { text: string } | null) {
    await act(async () => {
      await root.rerender(
        <DiffFileTree
          entries={files}
          ariaLabel="Decoration refresh files"
          onSelectFile={onSelectFile}
          renderFileDecoration={renderFileDecoration}
        />,
      );
    });
  }

  function treeScroller(): HTMLElement {
    for (const element of container.querySelectorAll("*")) {
      const scroller = element.shadowRoot?.querySelector<HTMLElement>(
        "[data-file-tree-virtualized-scroll]",
      );
      if (scroller) return scroller;
    }
    throw new Error("Expected the mounted tree's scroller");
  }

  /**
   * The tree lays its rows out again once its ResizeObserver measures the viewport, which can land
   * after the first render: it renders other rows (more decoration calls) and clamps `scrollTop`.
   * Observers report in one rendering step, so this later observer's first report follows the
   * tree's.
   */
  async function treeViewportMeasured() {
    const scroller = treeScroller();
    await act(
      () =>
        new Promise<void>((resolve) => {
          const observer = new ResizeObserver(() => {
            observer.disconnect();
            resolve();
          });
          observer.observe(scroller);
        }),
    );
  }

  it("DiffFileTree decoration guard: count-only updates preserve the model, selection, collapsed folders and keyboard entry", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const render = vi.spyOn(FileTreeModel.prototype, "render");
    await renderDecoration(() => ({ text: "+9 −2" }));
    await treeViewportMeasured();
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
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(scroller.scrollTop).toBe(20);

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
    await using _browserFixture0 = await setupBrowserFixture0();

    const decoration = vi.fn(() => ({ text: "+9 −2" }));
    await renderDecoration(decoration);
    await treeViewportMeasured();
    const calls = decoration.mock.calls.length;
    await renderDecoration(decoration);
    expect(decoration.mock.calls.length).toBe(calls);

    await act(async () => {
      root.rerender(
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
