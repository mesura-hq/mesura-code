// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout, as `routes/__root.tsx`
 * does, and whose chat layout is the real `_chat.tsx` route component: the
 * chat route's global shortcuts (pane navigation among them) and the real
 * KeyEngineHost around the real ChatView. The key engine is installed on
 * `window` before React renders, as `main.tsx` does. Keys are real `keydown`
 * events dispatched from the focused element.
 *
 * Phase 4 of the modal keys production cycle (Vim mode on, landing in normal
 * mode):
 * - Criterion 3: the palette opened and closed from the chat in normal mode
 *   leaves the chat scope in NORMAL with the chat cursor where it was.
 * - Criterion 4: the palette returns to the composer in the mode it left.
 * - Criterion 5, guard: a palette row that opens the file manager hands it the
 *   keyboard.
 * - Criterion 6: `Ctrl+K` from the terminal drawer and `Ctrl+L` from the
 *   sidebar land in the chat scope in NORMAL, never in the composer.
 * - Criterion 7, guards: with Vim mode off, closing the palette focuses the
 *   composer and the pane chords enter the composer, as upstream does.
 *
 * Boundaries the fixture replaces, and nothing else: the environment and
 * thread reads, every RPC command and query, the chords (the shipped
 * defaults, as a fresh keybindings file resolves them), unrelated chrome, the
 * CSS highlight registry happy-dom lacks (recorded instead of painted), the
 * sidebar's thread list (one focusable row), the terminal drawer (its root
 * and xterm's helper textarea, which is all the pane code reads), and the
 * file manager layer (its focusable root while the store is open; the vendor
 * app needs a live server). The setup follows
 * `AppRoot.commandRegistry.fence.test.tsx`.
 */
import { act } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

// The boundaries the fixture replaces: see `test/appRootFenceMocks.tsx`.
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async () => (await fenceMocks()).mockQuery());
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
vi.mock("./components/files/mesuraFileManager/MesuraFileManagerLayer", async () =>
  (await fenceMocks()).mockFileManagerLayer(),
);
vi.mock("./keys/highlights", async () => (await fenceMocks()).mockHighlights());
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());

vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);

import { useFileManagerStore } from "./components/files/mesuraFileManager/fileManagerStore";
import { installKeyEngine } from "./keys/keyEngine";
import { openCommandPalette } from "./commandPaletteBus";
import { composerEditorElement } from "./keys/focusScope";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";

const threadId = ThreadId.make("vim-landing-thread");
import { addFenceThread, makeMessage, renderFenceApp } from "./test/appRootFenceApp";
import { appRootFence as fixture } from "./test/appRootFenceMocks";

let root: Root | undefined;
let container: HTMLDivElement;

beforeAll(() => {
  installKeyEngine();
});

function seedThread() {
  addFenceThread(threadId, "Vim landing", [
    makeMessage("vim-landing-user", "user", "Fix the build"),
    makeMessage(
      "vim-landing-assistant",
      "assistant",
      "The first paragraph of the answer.\n\nThe second paragraph.\n\nThe third paragraph.\n\nThe last paragraph.",
    ),
  ]);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  seedThread();
  fixture.vimMode = false;
  fixture.highlights.clear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => useFileManagerStore.getState().setOpen(false));
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  document.querySelector("[data-testid='terminal-drawer']")?.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountApp(options: { readonly vimMode: boolean }, selectedThreadId = threadId) {
  ({ root } = await renderFenceApp(container, selectedThreadId, options));
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
}

/** Dispatches one keydown from the focused element, as the browser does. */
async function press(chord: Chord) {
  const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await settle();
  return event;
}

const key = (letter: string): Chord => ({ key: letter, code: `Key${letter.toUpperCase()}` });
const ESCAPE: Chord = { key: "Escape", code: "Escape" };
// Mod is Control here: happy-dom reports a non-Mac platform.
const PALETTE_CHORD: Chord = { key: "o", code: "KeyO", ctrlKey: true };
const PANE_UP_CHORD: Chord = { key: "k", code: "KeyK", ctrlKey: true };
const PANE_RIGHT_CHORD: Chord = { key: "l", code: "KeyL", ctrlKey: true };

function palette(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="command-palette"]');
}

async function openPalette() {
  await press(PALETTE_CHORD);
  expect(palette(), "the palette chord opened the palette").not.toBeNull();
}

async function closePalette() {
  await press(ESCAPE);
  expect(palette(), "Escape closed the palette").toBeNull();
}

function composer(): HTMLElement {
  const editor = composerEditorElement();
  expect(editor, "the composer editor is mounted").not.toBeNull();
  return editor!;
}

function focusIsInComposer(): boolean {
  return composer().contains(document.activeElement);
}

async function focusComposer() {
  await act(async () => composer().focus());
  await settle();
}

/** Where the chat cursor was last painted: its text node and offset. */
function chatCursor(): { readonly node: Node; readonly offset: number } | null {
  const range = fixture.highlights.get("mesura-chat-cursor")?.[0];
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** Mounts the terminal drawer's root inside the chat column, with xterm's helper textarea. */
function mountTerminalDrawer(): HTMLTextAreaElement {
  const column = document.querySelector<HTMLElement>("[data-chat-column-maximized-away]");
  expect(column, "the chat column is mounted").not.toBeNull();
  const drawer = document.createElement("div");
  drawer.dataset.terminalOwner = "drawer";
  drawer.dataset.testid = "terminal-drawer";
  const textarea = document.createElement("textarea");
  drawer.append(textarea);
  column!.append(drawer);
  return textarea;
}

function sidebarRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>('[data-testid="sidebar-thread-row"]');
  expect(row, "the sidebar thread row is mounted").not.toBeNull();
  return row!;
}

describe("vim landing fence: the palette returns where it was opened", () => {
  it("vim landing fence spec: palette from the chat in normal mode returns to the chat in NORMAL with the cursor kept", async () => {
    await mountApp({ vimMode: true });
    // Two lines up from where a fresh cursor starts.
    await press(key("k"));
    await press(key("k"));
    const before = chatCursor();
    expect(before, "the chat cursor was painted").not.toBeNull();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });

    await openPalette();
    await closePalette();

    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
    // A cursor kept at `before` returns to it after one line down and one up;
    // a fresh cursor, on the last line, would not.
    await press(key("j"));
    await press(key("k"));
    expect(chatCursor()).toEqual(before);
  });

  it("vim landing fence spec: palette from the composer in normal mode returns to the composer in NORMAL", async () => {
    await mountApp({ vimMode: true });
    await focusComposer();
    await press(ESCAPE);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });

    await openPalette();
    await closePalette();

    expect(focusIsInComposer()).toBe(true);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });
  });

  it("vim landing fence guard: palette from the composer in insert mode returns to the composer in INSERT", async () => {
    await mountApp({ vimMode: true });
    await focusComposer();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });

    await openPalette();
    await closePalette();

    expect(focusIsInComposer()).toBe(true);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
  });
});

describe("phone palette restoration through the real collapsed composer", () => {
  function setViewportWidth(width: number) {
    if (
      !("happyDOM" in window) ||
      typeof window.happyDOM !== "object" ||
      window.happyDOM === null ||
      !("setWindowSize" in window.happyDOM) ||
      typeof window.happyDOM.setWindowSize !== "function"
    )
      throw new Error("This fence requires Happy DOM's public viewport API.");
    window.happyDOM.setWindowSize({ width });
  }

  interface PaletteComposer {
    editor: HTMLElement;
    surface: Element;
    prompt: string;
  }

  async function withPaletteComposer(
    width: number,
    mode: string,
    label: string,
    check: (composer: PaletteComposer) => Promise<void>,
  ) {
    const previousWidth = window.innerWidth;
    let restoreFocus: (() => void) | undefined;
    const prompt = "hello world";
    try {
      const selectedThreadId = addFenceThread(
        `phone-palette-${label}-${mode}-${width}`,
        "Phone palette",
        [
          makeMessage(
            `phone-palette-message-${label}-${mode}-${width}`,
            "assistant",
            "Synthetic reply",
          ),
        ],
      );
      await act(async () => setViewportWidth(width));
      await mountApp({ vimMode: true }, selectedThreadId);
      const editor = composer();
      const nativeFocus = editor.focus.bind(editor);
      // Happy DOM ignores CSS when focusing. Model only the browser's refusal
      // to focus this editor inside the real composer's hidden body. The app
      // still owns collapse, expansion, selection, palette cleanup and Vim mode.
      const visibleFocus = vi.spyOn(editor, "focus").mockImplementation((options) => {
        if (editor.closest("[data-chat-composer-body]")?.classList.contains("hidden")) return;
        nativeFocus(options);
      });
      restoreFocus = () => visibleFocus.mockRestore();
      const surface = editor.closest("[data-chat-composer-surface]")!;
      const mobile = width < 640;
      expect(window.matchMedia("(max-width: 639px)").matches).toBe(mobile);
      await focusComposer();
      await act(async () => editor.blur());
      await settle();
      if (mobile) {
        expect(surface.getAttribute("data-chat-composer-mobile-collapsed")).toBe("true");
        const expand = surface.querySelector<HTMLButtonElement>('[aria-label="Expand composer"]')!;
        await act(async () => expand.click());
      } else await focusComposer();
      await settle();
      expect(focusIsInComposer()).toBe(true);
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", prompt);
      await act(async () =>
        editor.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        ),
      );
      await settle();
      expect(editor.textContent).toBe(prompt);
      if (mode === "NORMAL") {
        await press(ESCAPE);
        await press({ key: "0", code: "Digit0" });
        await press(key("l"));
        await press(key("l"));
        expect(window.getSelection()?.anchorOffset).toBe(2);
      }
      expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode });
      await openPalette();
      expect(surface.getAttribute("data-chat-composer-mobile-collapsed")).toBe(String(mobile));
      expect(editor.closest("[data-chat-composer-body]")?.classList.contains("hidden")).toBe(
        mobile,
      );
      await check({ editor, surface, prompt });
    } finally {
      restoreFocus?.();
      await act(async () => setViewportWidth(previousWidth));
      await settle();
    }
  }

  async function expectRestoredComposer(
    { editor, surface, prompt }: PaletteComposer,
    mode: string,
  ) {
    await closePalette();
    expect(focusIsInComposer()).toBe(true);
    expect(surface.getAttribute("data-chat-composer-mobile-collapsed")).toBe("false");
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode });
    expect(editor.textContent).toBe(prompt);
    if (mode === "NORMAL") {
      expect(window.getSelection()?.anchorOffset).toBe(2);
      await press(key("x"));
      expect(editor.textContent).toBe("helo world");
      await press(key("u"));
      expect(editor.textContent).toBe(prompt);
      await press({ key: "r", code: "KeyR", ctrlKey: true });
      expect(editor.textContent).toBe("helo world");
    } else {
      expect(window.getSelection()?.anchorNode?.textContent).toBe(prompt);
      expect(window.getSelection()?.anchorOffset).toBe(prompt.length);
    }
  }

  it.each([
    { width: 393, mode: "NORMAL" },
    { width: 412, mode: "NORMAL" },
    { width: 393, mode: "INSERT" },
    { width: 412, mode: "INSERT" },
  ])(
    "phone palette restore regression: $mode survives hidden editor at $width pixels",
    async ({ width, mode }) => {
      await withPaletteComposer(width, mode, "return", (composer) =>
        expectRestoredComposer(composer, mode),
      );
    },
  );

  it.each(["NORMAL", "INSERT"])(
    "desktop palette restore guard: %s keeps nonempty draft and caret",
    async (mode) => {
      await withPaletteComposer(1184, mode, "return", (composer) =>
        expectRestoredComposer(composer, mode),
      );
    },
  );

  it.each([
    { mode: "NORMAL", owner: "modal" },
    { mode: "INSERT", owner: "modal" },
    { mode: "NORMAL", owner: "file manager" },
    { mode: "INSERT", owner: "file manager" },
    { mode: "NORMAL", owner: "composer control" },
    { mode: "INSERT", owner: "composer control" },
  ])(
    "phone palette restore ownership: $owner cancels deferred $mode focus",
    async ({ mode, owner }) => {
      await withPaletteComposer(412, mode, owner, async ({ editor, surface, prompt }) => {
        let activated = false;
        let managerFocused = false;
        let modal: HTMLDivElement | undefined;
        let control: HTMLButtonElement | undefined;
        // Observe the real reveal commit before the existing focus frame. This
        // models another public owner arriving after the palette's close callback.
        const observer = new MutationObserver(() => {
          if (
            !activated &&
            surface.getAttribute("data-chat-composer-mobile-collapsed") === "false"
          ) {
            activated = true;
            if (owner === "file manager") useFileManagerStore.getState().setOpen(true);
            else if (owner === "composer control") {
              control = [
                ...surface.querySelectorAll<HTMLButtonElement>("[data-chat-provider-model-picker]"),
              ].find((element) => element.closest("[inert]") === null);
              act(() => control?.focus());
            } else {
              modal = document.createElement("div");
              modal.setAttribute("role", "dialog");
              modal.setAttribute("aria-modal", "true");
              modal.tabIndex = -1;
              document.body.append(modal);
              modal.focus();
            }
          }
          if (activated && owner === "file manager" && !managerFocused) {
            // The shared fixture renders only the vendor layer's root. Model
            // its real focus-on-mount boundary without changing that fixture.
            const layer = document.querySelector<HTMLElement>('[data-testid="file-manager"]');
            if (layer) {
              managerFocused = true;
              layer.focus({ preventScroll: true });
            }
          }
        });
        observer.observe(surface, {
          attributes: true,
          attributeFilter: ["data-chat-composer-mobile-collapsed"],
        });
        observer.observe(document.body, { childList: true, subtree: true });
        try {
          await closePalette();
          expect(activated, "the later owner arrived between reveal and deferred focus").toBe(true);
          const currentOwner =
            control ?? modal ?? document.querySelector('[data-testid="file-manager"]');
          expect(currentOwner).not.toBeNull();
          expect(document.activeElement).toBe(currentOwner);
          expect(focusIsInComposer()).toBe(false);
          expect(surface.getAttribute("data-chat-composer-mobile-collapsed")).toBe(
            String(owner !== "composer control"),
          );
          expect(editor.textContent).toBe(prompt);
          await settle();
          expect(document.activeElement).toBe(currentOwner);
          await act(async () => {
            modal?.remove();
            useFileManagerStore.getState().setOpen(false);
          });
          await settle();
          // A later independent expansion must not inherit an aborted NORMAL receipt.
          if (owner === "composer control") await focusComposer();
          else {
            const expand = surface.querySelector<HTMLButtonElement>(
              '[aria-label="Expand composer"]',
            )!;
            await act(async () => expand.click());
          }
          await settle();
          expect(focusIsInComposer()).toBe(true);
          expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
          expect(editor.textContent).toBe(prompt);
        } finally {
          observer.disconnect();
          await act(async () => {
            modal?.remove();
            useFileManagerStore.getState().setOpen(false);
          });
        }
      });
    },
  );
});

describe("vim landing fence: a file manager row keeps the keyboard", () => {
  const vimModeCases = [true, false].map((vimMode) => ({
    vimMode,
    label: vimMode ? "Vim mode on" : "Vim mode off",
  }));

  it.each(vimModeCases)(
    "vim landing fence guard: the Open file manager row hands the file manager the keyboard with $label",
    async ({ vimMode }) => {
      await mountApp({ vimMode });
      await openPalette();
      const row = [...palette()!.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
        option.textContent?.includes("Open file manager"),
      );
      expect(row, `the palette offers the row; rendered: ${palette()!.textContent}`).toBeDefined();
      await act(async () => row!.click());
      await settle();

      expect(palette()).toBeNull();
      const fileManager = document.querySelector('[data-testid="file-manager"]');
      expect(fileManager).not.toBeNull();
      expect(document.activeElement).toBe(fileManager);
    },
  );
});

describe("vim landing fence: pane chords into the chat land in normal mode", () => {
  it("vim landing fence spec: Ctrl+K from the terminal drawer lands in the chat scope in NORMAL", async () => {
    await mountApp({ vimMode: true });
    const terminal = mountTerminalDrawer();
    await act(async () => terminal.focus());

    const event = await press(PANE_UP_CHORD);

    expect(event.defaultPrevented).toBe(true);
    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  });

  it("vim landing fence spec: Ctrl+L from the sidebar lands in the chat scope in NORMAL", async () => {
    await mountApp({ vimMode: true });
    await act(async () => sidebarRow().focus());

    const event = await press(PANE_RIGHT_CHORD);

    expect(event.defaultPrevented).toBe(true);
    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  });
});

describe("vim landing fence: review regressions", () => {
  // Review P1-1: the engine consumes Escape and `i`, so a resume armed by the
  // palette's close must not outlive them.
  it("vim landing fence regression: after a palette round trip from composer NORMAL, Escape then i enters the composer in INSERT", async () => {
    await mountApp({ vimMode: true });
    await focusComposer();
    await press(ESCAPE);
    await openPalette();
    await closePalette();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });

    await press(ESCAPE);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
    await press(key("i"));
    expect(focusIsInComposer()).toBe(true);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
    // Typing reaches the editor: the engine passes insert-mode keys through.
    expect((await press(key("x"))).defaultPrevented).toBe(false);
  });

  // Review P1-2: entering the chat by a pane chord lands in NORMAL even when
  // the chat was left in VISUAL.
  it("vim landing fence regression: Ctrl+L from the sidebar after leaving the chat in VISUAL lands in NORMAL", async () => {
    await mountApp({ vimMode: true });
    await press(key("v"));
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "VISUAL" });
    await act(async () => sidebarRow().focus());

    await press(PANE_RIGHT_CHORD);

    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  });

  it("vim landing fence regression: Ctrl+K from the terminal drawer after leaving the chat in VISUAL lands in NORMAL", async () => {
    await mountApp({ vimMode: true });
    await press(key("v"));
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "VISUAL" });
    const terminal = mountTerminalDrawer();
    await act(async () => terminal.focus());

    await press(PANE_UP_CHORD);

    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  });
});

describe("vim landing fence: Vim mode off behaves as upstream", () => {
  it("vim landing fence guard: closing the palette focuses the composer with Vim mode off", async () => {
    await mountApp({ vimMode: false });
    await openPalette();
    await closePalette();
    expect(focusIsInComposer()).toBe(true);
  });

  it("vim landing fence guard: Ctrl+K from the terminal drawer enters the composer with Vim mode off", async () => {
    await mountApp({ vimMode: false });
    const terminal = mountTerminalDrawer();
    await act(async () => terminal.focus());
    const event = await press(PANE_UP_CHORD);
    expect(event.defaultPrevented).toBe(true);
    expect(focusIsInComposer()).toBe(true);
  });

  it("vim landing fence guard: Ctrl+L from the sidebar enters the composer with Vim mode off", async () => {
    await mountApp({ vimMode: false });
    await act(async () => sidebarRow().focus());
    const event = await press(PANE_RIGHT_CHORD);
    expect(event.defaultPrevented).toBe(true);
    expect(focusIsInComposer()).toBe(true);
  });
});

// The close callback waits for React to clear inert. Later owners must retain focus.
describe("vim landing fence: deferred focus guards", () => {
  it("vim landing fence guard: reopening the palette before close focus runs keeps focus in the reopened palette", async () => {
    await mountApp({ vimMode: true });
    await focusComposer();
    await press(ESCAPE);
    await openPalette();
    await act(async () => {
      flushSync(() => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", {
            ...ESCAPE,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      flushSync(() => openCommandPalette());
    });
    await settle();
    expect(palette(), "the palette reopened").not.toBeNull();
    expect(palette()!.contains(document.activeElement), "the reopened palette owns focus").toBe(
      true,
    );
    expect(focusIsInComposer()).toBe(false);
  });

  it("vim landing fence guard: unmounting the app after close preserves focus in another owner", async () => {
    await mountApp({ vimMode: true });
    await openPalette();
    const nextOwner = document.createElement("input");
    document.body.append(nextOwner);
    try {
      await act(async () => {
        flushSync(() => {
          (document.activeElement ?? document.body).dispatchEvent(
            new KeyboardEvent("keydown", {
              ...ESCAPE,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        root!.unmount();
        root = undefined;
        nextOwner.focus();
      });
      await settle();
      expect(document.activeElement).toBe(nextOwner);
    } finally {
      nextOwner.remove();
    }
  });
});
