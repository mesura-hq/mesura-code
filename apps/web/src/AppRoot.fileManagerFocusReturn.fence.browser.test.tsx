import { page } from "vite-plus/test/browser";
import { act, type Screen, fakeTimers } from "../test/render";
/**
 * Entry point: AppRoot with the real chat route, ChatComposer, key engine and
 * MesuraFileManagerLayer. Shared AppRoot boundaries replace RPCs and unrelated
 * chrome. Only the vendor App/bridge are replaced here; the layer's portal,
 * mount focus, unmount cleanup and native Escape boundary remain production.
 * Chromium loads the app's styles and owns layout, hidden-composer focus and
 * visibility. Control the full clock to exercise the focus and release frames;
 * wait for the editor and focus before exercising a return.
 */
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const fileManagerBoundary = vi.hoisted(() => ({ hostAtom: {} }));
// main.tsx wraps the real AppRoot in StrictMode. Keep that lifecycle here.
vi.mock("./AppRoot", async (importOriginal) => {
  const { StrictMode } = await import("react");
  const actual = await importOriginal<typeof import("./AppRoot")>();
  return {
    ...actual,
    AppRoot: (props: ComponentProps<typeof actual.AppRoot>) => (
      <StrictMode>
        <actual.AppRoot {...props} />
      </StrictMode>
    ),
  };
});
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => {
  const common = await (await fenceMocks()).mockQuery(original);
  return {
    ...common,
    useEnvironmentQuery: (atom?: object | null) => {
      const result = common.useEnvironmentQuery(atom);
      return atom === fileManagerBoundary.hostAtom
        ? { ...result, data: { homePath: "/synthetic" } }
        : result;
    },
  };
});
vi.mock("./state/queries", async (original) => (await fenceMocks()).mockQueries(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", async () => (await fenceMocks()).mockAtomCommand());
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
vi.mock("./state/server", async (original) => (await fenceMocks()).mockServer(original));
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => (await fenceMocks()).mockThreadActions());
vi.mock("./components/Sidebar", async () => (await fenceMocks()).mockSidebar());
vi.mock("./components/LegacySidebar", async () =>
  (await fenceMocks()).mockRendersNothing("default"),
);
vi.mock("./components/preview/PreviewAutomationHosts", async () =>
  (await fenceMocks()).mockRendersNothing("PreviewAutomationHosts"),
);
vi.mock("./browser/ElectronBrowserHost", async () =>
  (await fenceMocks()).mockRendersNothing("ElectronBrowserHost"),
);
vi.mock("./components/QuitHoldOverlay", async () =>
  (await fenceMocks()).mockRendersNothing("QuitHoldOverlay"),
);
vi.mock("./components/chat/ChatHeader", async () =>
  (await fenceMocks()).mockRendersNothing("ChatHeader"),
);
vi.mock("./components/BranchToolbar", async () =>
  (await fenceMocks()).mockRendersNothing("BranchToolbar"),
);
vi.mock("./keys/highlights", async () => (await fenceMocks()).mockHighlights());
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());

vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);

vi.mock("./state/fileManagerRpc", () => ({
  fileManagerHost: () => fileManagerBoundary.hostAtom,
  createFileManagerTransport: () => ({}),
}));
vi.mock("./components/files/mesuraFileManager/wsBridge", () => ({
  createWsBridge: () => ({ dispose: () => {} }),
}));
vi.mock("./components/files/mesuraFileManager/bridgeInstall", () => ({
  installFileManagerBridge: () => () => {},
}));
vi.mock("@symmetria/fm-ui/bridge", () => ({ openPath: vi.fn() }));
vi.mock("@symmetria/fm-ui/App", () => ({
  App: ({ onDismiss }: { onDismiss: () => void }) => (
    <div
      data-testid="synthetic-current-column"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      Synthetic current column
    </div>
  ),
}));

import { useFileManagerStore } from "./components/files/mesuraFileManager/fileManagerStore";
import { installKeyEngine } from "./keys/keyEngine";
import { composerEditorElement } from "./keys/focusScope";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { flushBrowserTasks } from "./test/browserTasks";
import {
  addFenceThread,
  fenceEnvironmentId,
  makeMessage,
  renderFenceApp,
} from "./test/appRootFenceApp";

let root: Screen | undefined;
let container: HTMLDivElement;
let restoreViewport: (() => Promise<void>) | undefined;

async function setupBrowserFixture0() {
  const timers = fakeTimers();
  await installKeyEngine();

  container = document.createElement("div");
  container.style.cssText = "width: 100%; height: 100dvh;";
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => useFileManagerStore.getState().setOpen(false));
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      await restoreViewport?.();
      restoreViewport = undefined;
      container.remove();
      vi.unstubAllGlobals();
      timers[Symbol.dispose]();
    },
  };
}

/** Advance the controlled focus and release frames after their DOM milestones. */
async function frames() {
  for (let frame = 0; frame < 2; frame += 1) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }
}

async function press(key: string, code = key, modifiers = {}) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, code, ...modifiers, bubbles: true, cancelable: true }),
    );
  });
  await flushBrowserTasks();
}

async function setViewportWidth(width: number) {
  await page.viewport(width, window.innerHeight);
}

async function expandComposer(surface: Element) {
  await vi.waitFor(() =>
    expect(surface.getAttribute("data-chat-composer-mobile-collapsed")).toBe("true"),
  );
  await page
    .elementLocator(surface.querySelector<HTMLButtonElement>('[aria-label="Expand composer"]')!)
    .click();
}

async function prepareComposer(width: number, mode: string, label = "return") {
  const previousWidth = window.innerWidth;
  restoreViewport = () => setViewportWidth(previousWidth);
  await setViewportWidth(width);
  const threadId = addFenceThread(
    `file-manager-return-${label}-${mode}-${width}`,
    "File manager focus",
    [
      makeMessage(
        `file-manager-return-message-${label}-${mode}-${width}`,
        "assistant",
        "Synthetic reply",
      ),
    ],
  );
  const mounted = await renderFenceApp(container, threadId, { vimMode: true });
  root = mounted.root;
  await frames();
  await vi.waitFor(() =>
    expect(composerEditorElement(), "the route mounts its editor").not.toBeNull(),
  );
  const editor = composerEditorElement()!;
  const surface = editor.closest("[data-chat-composer-surface]")!;
  await frames();
  if (width < 640 && surface.getAttribute("data-chat-composer-mobile-collapsed") === "true")
    await expandComposer(surface);
  await frames();
  // Observe the route's initial focus before blurring. A late startup frame
  // would otherwise compete with the file manager's focus return.
  await vi.waitFor(() => expect(document.activeElement).toBe(editor));
  await page.elementLocator(editor).click();
  await frames();
  await act(async () => editor.blur());
  if (width < 640) await expandComposer(surface);
  else await act(async () => editor.focus());
  await vi.waitFor(() => expect(document.activeElement).toBe(editor));
  await frames();
  expect(document.activeElement).toBe(editor);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "hello world");
  await act(async () =>
    editor.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    ),
  );
  await vi.waitFor(() => expect(editor.textContent).toBe("hello world"));
  await press("Escape", "Escape");
  await press("0", "Digit0");
  await press("l", "KeyL");
  await press("l", "KeyL");
  if (mode === "INSERT") await press("i", "KeyI");
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode });
  expect(window.getSelection()?.anchorOffset).toBe(2);
  return { editor, surface, router: mounted.router };
}

async function openManager() {
  await press("E", "KeyE", { ctrlKey: true, shiftKey: true });
  await vi.waitFor(() => {
    const manager = document.querySelector('[aria-label="File manager"]');
    expect(manager).not.toBeNull();
    expect(manager?.querySelector('[data-testid="synthetic-current-column"]')).not.toBeNull();
    expect(document.activeElement).toBe(manager);
  });
  const manager = document.querySelector<HTMLElement>('[aria-label="File manager"]')!;
  expect(manager).not.toBeNull();
  expect(manager.querySelector('[data-testid="synthetic-current-column"]')).not.toBeNull();
  expect(document.activeElement).toBe(manager);
  // The phone collapses after blur in its own frame. Closing before that
  // milestone would bypass the hidden-editor return path this fence guards.
  await vi.waitFor(() =>
    expect(
      document
        .querySelector("[data-chat-composer-surface]")
        ?.getAttribute("data-chat-composer-mobile-collapsed"),
    ).toBe(String(window.innerWidth < 640)),
  );
  return manager;
}

async function closeManager() {
  await act(async () => {
    document.querySelector('[data-testid="synthetic-current-column"]')!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await vi.waitFor(() => expect(document.querySelector('[aria-label="File manager"]')).toBeNull());
  await frames();
  expect(document.querySelector('[aria-label="File manager"]')).toBeNull();
}

describe("real file-manager focus-return fence", () => {
  it.each([
    { width: 412, mode: "NORMAL" },
    { width: 412, mode: "INSERT" },
    { width: 1184, mode: "NORMAL" },
    { width: 1184, mode: "INSERT" },
  ])(
    "file-manager return regression: $mode preserves caret at $width pixels",
    async ({ width, mode }) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      const { editor, surface } = await prepareComposer(width, mode);
      await openManager();
      expect(surface.getAttribute("data-chat-composer-mobile-collapsed")).toBe(String(width < 640));
      // Deliver Escape at the vendor boundary. The real layer owns the return.
      await closeManager();
      await vi.waitFor(() => expect(document.activeElement).toBe(editor));
      expect(document.querySelector('[aria-label="File manager"]')).toBeNull();
      expect(document.activeElement).toBe(editor);
      expect(surface.getAttribute("data-chat-composer-mobile-collapsed")).toBe("false");
      expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode });
      expect(editor.textContent).toBe("hello world");
      expect(window.getSelection()?.anchorOffset).toBe(2);
      if (mode === "NORMAL") {
        await press("x", "KeyX");
        expect(editor.textContent).toBe("helo world");
        await press("u", "KeyU");
        expect(editor.textContent).toBe("hello world");
        await press("r", "KeyR", { ctrlKey: true });
        expect(editor.textContent).toBe("helo world");
      }
      await frames();
      expect(document.activeElement).toBe(editor);
    },
  );

  it("file-manager return guard: a noncomposer origin keeps its direct focus path", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await prepareComposer(1184, "INSERT", "external");
    const origin = document.createElement("button");
    container.append(origin);
    await act(async () => origin.focus());
    await openManager();
    await act(async () => useFileManagerStore.getState().setOpen(false));
    await frames();
    expect(document.activeElement).toBe(origin);
  });

  it.each(["modal", "panel"])(
    "file-manager return ownership: a later %s retains the keyboard on close",
    async (owner) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      const { editor } = await prepareComposer(1184, "NORMAL", owner);
      await openManager();
      const nextOwner = document.createElement("div");
      nextOwner.tabIndex = -1;
      if (owner === "modal") {
        nextOwner.setAttribute("role", "dialog");
        nextOwner.setAttribute("aria-modal", "true");
      } else nextOwner.setAttribute("data-right-panel-surface-content", "true");
      document.body.append(nextOwner);
      try {
        await act(async () => nextOwner.focus());
        await act(async () => useFileManagerStore.getState().setOpen(false));
        await frames();
        expect(document.activeElement).toBe(nextOwner);
        expect(editor.textContent).toBe("hello world");
        await frames();
        expect(document.activeElement).toBe(nextOwner);
      } finally {
        nextOwner.remove();
      }
    },
  );

  it("file-manager return ownership: reopening after removal cancels the old return", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { editor } = await prepareComposer(412, "NORMAL", "reopen");
    const manager = await openManager();
    let reopened = false;
    const observer = new MutationObserver(() => {
      if (!reopened && !manager.isConnected) {
        reopened = true;
        // The close's act owns this mutation. An async observer act can leave later renders pending.
        useFileManagerStore.getState().setOpen(true);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      await act(async () => useFileManagerStore.getState().setOpen(false));
      await frames();
      expect(reopened).toBe(true);
      const current = document.querySelector('[aria-label="File manager"]');
      expect(current).not.toBe(manager);
      expect(current).not.toBeNull();
      expect(document.activeElement).toBe(current);
      expect(editor.closest("[data-chat-composer-body]")?.classList.contains("hidden")).toBe(true);
      await frames();
      expect(document.activeElement).toBe(current);
    } finally {
      observer.disconnect();
    }
  });

  it("file-manager return identity: a route change before close retains the new draft", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { router } = await prepareComposer(412, "NORMAL", "route");
    const manager = await openManager();
    const nextThread = addFenceThread("file-manager-next-thread", "Next draft", [
      makeMessage("file-manager-next-message", "assistant", "Synthetic next reply"),
    ]);
    await act(async () =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: fenceEnvironmentId, threadId: nextThread },
      }),
    );
    await vi.waitFor(() => expect(composerEditorElement()?.textContent).toBe(""));
    await frames();
    expect(document.querySelector('[aria-label="File manager"]')).toBe(manager);
    expect(document.activeElement).toBe(manager);
    const nextEditor = composerEditorElement()!;
    expect(nextEditor.textContent).toBe("");
    await closeManager();
    expect(document.activeElement).not.toBe(nextEditor);
    expect(nextEditor.textContent).toBe("");
    expect(nextEditor.getAttribute("data-mesura-vim")).toBeNull();
  });

  it("file-manager return ownership: an explicit composer entry retains its new caret and mode", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { editor } = await prepareComposer(1184, "NORMAL", "explicit-entry");
    await openManager();
    await act(async () => editor.focus());
    await press("Escape", "Escape");
    await press("0", "Digit0");
    for (let step = 0; step < 5; step += 1) await press("l", "KeyL");
    await press("i", "KeyI");
    expect(window.getSelection()?.anchorOffset).toBe(5);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
    await act(async () => useFileManagerStore.getState().setOpen(false));
    await frames();
    expect(document.activeElement).toBe(editor);
    expect(window.getSelection()?.anchorOffset).toBe(5);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
  });

  it("file-manager return identity: a route change during reveal preserves the new route's INSERT entry", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const { editor, surface, router } = await prepareComposer(412, "NORMAL", "pending-route");
    await openManager();
    const nextThread = addFenceThread("file-manager-reveal-next-thread", "Next revealed draft", [
      makeMessage("file-manager-reveal-next-message", "assistant", "Synthetic next reply"),
    ]);
    // Hold this race's focus frames until the public route commit.
    // Preserve the controlled clock's frame IDs and cancellation.
    let releaseFrames = () => {};
    const routeCommit = new Promise<void>((resolve) => {
      releaseFrames = resolve;
    });
    const scheduleFrame = window.requestAnimationFrame.bind(window);
    const cancelFrame = window.cancelAnimationFrame.bind(window);
    const cancelled = new Set<number>();
    const frameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = scheduleFrame((time) => {
        void routeCommit.then(() => {
          if (!cancelled.has(id)) callback(time);
        });
      });
      return id;
    });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      cancelled.add(id);
      cancelFrame(id);
    });
    try {
      await act(async () => {
        document.querySelector('[data-testid="synthetic-current-column"]')!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(surface.getAttribute("data-chat-composer-mobile-collapsed")).toBe("false");
      expect(document.activeElement, "reveal precedes deferred focus").not.toBe(editor);
      expect(frameSpy).toHaveBeenCalled();
      // Hold the reveal's queued focus. The router needs its own frames to commit.
      frameSpy.mockRestore();
      await act(async () =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: fenceEnvironmentId, threadId: nextThread },
        }),
      );
      // draftKey remounts the editor. Wait for the new draft before releasing old focus work.
      const nextEditor = await vi.waitFor(() => {
        const current = composerEditorElement();
        expect(current).not.toBeNull();
        expect(current).not.toBe(editor);
        expect(editor.isConnected).toBe(false);
        expect(current!.textContent).toBe("");
        return current!;
      });
      await frames();
      await vi.waitFor(() => expect(document.activeElement).toBe(nextEditor));
      expect(nextEditor.textContent, "the new draft commits before the queued focus frame").toBe(
        "",
      );
      expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
      expect(window.getSelection()?.anchorOffset).toBe(0);
      await act(async () => releaseFrames());
      await vi.waitFor(() => expect(document.activeElement).toBe(nextEditor));
      await frames();
      expect(composerEditorElement()).toBe(nextEditor);
      expect(editor.isConnected).toBe(false);
      expect(nextEditor.textContent).toBe("");
      // ChatView independently focuses a new route at the end. Cancellation
      // of the old return must preserve that entry, rather than suppress it.
      expect(document.activeElement).toBe(nextEditor);
      expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
      expect(window.getSelection()?.anchorOffset).toBe(0);
      expect(nextEditor.getAttribute("data-mesura-vim")).toBeNull();
      await press("Escape", "Escape");
      await press("u", "KeyU");
      expect(nextEditor.textContent).toBe("");
      await press("r", "KeyR", { ctrlKey: true });
      expect(nextEditor.textContent).toBe("");
      await press("i", "KeyI");
      expect(document.activeElement).toBe(nextEditor);
      expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
      expect(window.getSelection()?.anchorOffset).toBe(0);
      expect(nextEditor.getAttribute("data-mesura-vim")).toBeNull();
    } finally {
      try {
        await act(async () => releaseFrames());
        await frames();
      } finally {
        frameSpy.mockRestore();
        cancelSpy.mockRestore();
      }
    }
  });
});
