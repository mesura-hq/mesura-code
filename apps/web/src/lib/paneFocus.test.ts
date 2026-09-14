import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  PANE_ORDER,
  focusPane,
  getFocusedPane,
  getLastFocusedPane,
  isPaneReachable,
  isSidebarSearchFocused,
  neighbourOf,
  registerPaneEntry,
} from "./paneFocus";

/**
 * A hand-built element, because this workspace installs no DOM for tests.
 * `terminalFocus.test.ts` establishes the pattern; this one adds a parent
 * chain so `closest` can walk, and a query registry so the module's
 * `document.querySelector` calls can be observed as well as answered.
 */
class FakeElement {
  isConnected = true;
  parent: FakeElement | null = null;
  focusCalls = 0;
  isContentEditable = false;
  readonly dataset: Record<string, string | undefined> = {};

  constructor(
    readonly selectors: ReadonlyArray<string> = [],
    readonly tagName: string = "DIV",
  ) {}

  closest(selector: string): FakeElement | null {
    return closestFrom(this, selector);
  }

  focus(): void {
    this.focusCalls += 1;
  }
}

function closestFrom(start: FakeElement, selector: string): FakeElement | null {
  let node: FakeElement | null = start;
  while (node !== null) {
    if (node.isConnected && node.selectors.includes(selector)) return node;
    node = node.parent;
  }
  return null;
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

/** Selectors the module asked `querySelector` for, in the order it asked. */
let queried: string[] = [];

function installDocument(input: {
  activeElement?: FakeElement | null;
  registry?: Record<string, FakeElement>;
}): void {
  queried = [];
  const registry = input.registry ?? {};
  globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
  globalThis.document = {
    activeElement: input.activeElement ?? null,
    querySelector: (selector: string) => {
      queried.push(selector);
      return registry[selector] ?? null;
    },
  } as unknown as Document;
}

const SIDEBAR = "[data-app-sidebar]";
const SIDEBAR_STATE_HOST = '[data-slot="sidebar"]';
const CHAT = "[data-chat-column-maximized-away]";
const PANEL = "[data-preview-panel-mode]";
const DRAWER = '[data-terminal-owner="drawer"]';

/**
 * The sidebar as the app really renders it: `data-app-sidebar` sits on the
 * inner container, and the collapsed state on its `[data-slot="sidebar"]`
 * parent. Verified in the running app — a fixture that put both on one
 * element would let a collapsed sidebar pass as reachable.
 */
function sidebarRoot(state = "expanded"): FakeElement {
  const stateHost = new FakeElement([SIDEBAR_STATE_HOST]);
  stateHost.dataset.state = state;
  const container = new FakeElement([SIDEBAR]);
  container.parent = stateHost;
  return container;
}

function chatRoot(maximizedAway = "false"): FakeElement {
  const root = new FakeElement([CHAT]);
  root.dataset.chatColumnMaximizedAway = maximizedAway;
  return root;
}

function panelRoot(mode = "inline"): FakeElement {
  const root = new FakeElement([PANEL]);
  root.dataset.previewPanelMode = mode;
  return root;
}

function drawerRoot(): FakeElement {
  const root = new FakeElement([DRAWER]);
  root.dataset.terminalOwner = "drawer";
  return root;
}

/** A descendant of `parent`, as the real active element always is. */
function childOf(parent: FakeElement): FakeElement {
  const child = new FakeElement([]);
  child.parent = parent;
  return child;
}

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("getFocusedPane", () => {
  it("names the pane whose root contains the active element", () => {
    for (const [pane, root] of [
      ["sidebar", sidebarRoot()],
      ["chat", chatRoot()],
      ["panel", panelRoot()],
      ["terminal", drawerRoot()],
    ] as const) {
      installDocument({ activeElement: childOf(root) });
      expect(getFocusedPane()).toBe(pane);
    }
  });

  it("returns null when the active element is under no pane root", () => {
    installDocument({ activeElement: new FakeElement([]) });
    expect(getFocusedPane()).toBeNull();
  });

  it("returns null when there is no active element at all", () => {
    installDocument({ activeElement: null });
    expect(getFocusedPane()).toBeNull();
  });

  it("returns null for a detached element, which can no longer own the keyboard", () => {
    const root = sidebarRoot();
    const active = childOf(root);
    active.isConnected = false;
    root.isConnected = false;
    installDocument({ activeElement: active });
    expect(getFocusedPane()).toBeNull();
  });

  it("resolves the terminal drawer as its own pane, not as the chat that contains it", () => {
    // The drawer is rendered inside the chat column, so a naive walk that
    // tested the chat first would report `chat` for a focused terminal.
    const chat = chatRoot();
    const drawer = drawerRoot();
    drawer.parent = chat;
    installDocument({ activeElement: childOf(drawer) });
    expect(getFocusedPane()).toBe("terminal");
  });
});

describe("getLastFocusedPane", () => {
  it("keeps the last named pane after focus falls back to the document body", () => {
    const panel = panelRoot();
    installDocument({ activeElement: childOf(panel) });
    expect(getFocusedPane()).toBe("panel");

    installDocument({ activeElement: new FakeElement([]) });
    expect(getFocusedPane()).toBeNull();
    expect(getLastFocusedPane()).toBe("panel");
  });
});

describe("isPaneReachable", () => {
  it("is true for every pane whose root is present and open", () => {
    installDocument({
      registry: {
        [SIDEBAR]: sidebarRoot(),
        [CHAT]: chatRoot(),
        [PANEL]: panelRoot(),
        [DRAWER]: drawerRoot(),
      },
    });
    for (const pane of ["sidebar", "chat", "panel", "terminal"] as const) {
      expect(isPaneReachable(pane)).toBe(true);
    }
  });

  it("is false for a pane whose root is absent", () => {
    installDocument({ registry: {} });
    for (const pane of ["sidebar", "chat", "panel", "terminal"] as const) {
      expect(isPaneReachable(pane)).toBe(false);
    }
  });

  it("is false for a collapsed sidebar, which is present but cannot hold focus", () => {
    // The collapsed sidebar stays in the document at its full width and
    // slides off-screen, so this can only be read from the state host above
    // the container that carries `data-app-sidebar`.
    installDocument({ registry: { [SIDEBAR]: sidebarRoot("collapsed") } });
    expect(isPaneReachable("sidebar")).toBe(false);
  });

  it("is false for a sidebar whose state host is missing, rather than assuming it is open", () => {
    const orphan = new FakeElement([SIDEBAR]);
    installDocument({ registry: { [SIDEBAR]: orphan } });
    expect(isPaneReachable("sidebar")).toBe(false);
  });

  it("is false for a chat column the right panel has maximized away", () => {
    installDocument({ registry: { [CHAT]: chatRoot("true") } });
    expect(isPaneReachable("chat")).toBe(false);
  });

  it("is false for a right panel that is not inline", () => {
    for (const mode of ["sheet", "sidebar", "embedded"]) {
      installDocument({ registry: { [PANEL]: panelRoot(mode) } });
      expect(isPaneReachable("panel")).toBe(false);
    }
  });
});

describe("neighbourOf", () => {
  const allReachable = {
    [SIDEBAR]: sidebarRoot(),
    [CHAT]: chatRoot(),
    [PANEL]: panelRoot(),
    [DRAWER]: drawerRoot(),
  };

  it("orders the horizontal panes sidebar, chat, panel", () => {
    expect([...PANE_ORDER]).toEqual(["sidebar", "chat", "panel"]);
  });

  it("steps one pane in the asked direction", () => {
    installDocument({ registry: allReachable });
    expect(neighbourOf("sidebar", "right")).toBe("chat");
    expect(neighbourOf("chat", "right")).toBe("panel");
    expect(neighbourOf("panel", "left")).toBe("chat");
    expect(neighbourOf("chat", "left")).toBe("sidebar");
  });

  it("returns null at each edge instead of wrapping round", () => {
    installDocument({ registry: allReachable });
    expect(neighbourOf("sidebar", "left")).toBeNull();
    expect(neighbourOf("panel", "right")).toBeNull();
  });

  it("skips an unreachable pane and lands on the one beyond it", () => {
    installDocument({
      registry: { [SIDEBAR]: sidebarRoot(), [CHAT]: chatRoot("true"), [PANEL]: panelRoot() },
    });
    expect(neighbourOf("sidebar", "right")).toBe("panel");
    expect(neighbourOf("panel", "left")).toBe("sidebar");
  });

  it("returns null when every pane beyond this one is unreachable", () => {
    installDocument({ registry: { [CHAT]: chatRoot() } });
    expect(neighbourOf("chat", "left")).toBeNull();
    expect(neighbourOf("chat", "right")).toBeNull();
  });

  it("treats the terminal drawer as the chat column for horizontal steps", () => {
    installDocument({ registry: allReachable });
    expect(neighbourOf("terminal", "left")).toBe("sidebar");
    expect(neighbourOf("terminal", "right")).toBe("panel");
  });
});

describe("focusPane", () => {
  it("prefers an entry a surface registered for itself", () => {
    const fallback = new FakeElement([]);
    installDocument({ registry: { "[data-preview-panel-mode] input": fallback } });

    let registeredCalls = 0;
    const unregister = registerPaneEntry("panel", () => {
      registeredCalls += 1;
      return true;
    });

    expect(focusPane("panel")).toBe(true);
    expect(registeredCalls).toBe(1);
    expect(fallback.focusCalls).toBe(0);

    unregister();
    expect(focusPane("panel")).toBe(true);
    expect(registeredCalls).toBe(1);
    expect(fallback.focusCalls).toBe(1);
  });

  it("keeps a newer registration when a superseded one is unregistered late", () => {
    // A surface that unregisters on unmount can do so after its replacement
    // has already registered. Without the identity guard that late call
    // would silently remove the live entry and send focus to a fallback.
    installDocument({ registry: {} });
    const calls: string[] = [];
    const unregisterFirst = registerPaneEntry("panel", () => {
      calls.push("first");
      return true;
    });
    const unregisterSecond = registerPaneEntry("panel", () => {
      calls.push("second");
      return true;
    });

    unregisterFirst();
    expect(focusPane("panel")).toBe(true);
    expect(calls).toEqual(["second"]);

    unregisterSecond();
    expect(focusPane("panel")).toBe(false);
  });

  it("falls back to the fallback entry when a registered one declines", () => {
    const fallback = new FakeElement([]);
    installDocument({ registry: { "[data-preview-panel-mode] input": fallback } });
    const unregister = registerPaneEntry("panel", () => false);

    expect(focusPane("panel")).toBe(true);
    expect(fallback.focusCalls).toBe(1);
    unregister();
  });

  it("enters the sidebar on a thread row, never on the toolbar", () => {
    // This assertion used to name `[data-sidebar="menu-button"][data-active]`
    // and call it the active thread row. It is not: in the running app those
    // are the six icon buttons in the sidebar's top and bottom bars, all of
    // them `data-active="false"`, so the old selector matched nothing and the
    // keyboard landed on the collapse toggle. A thread row is a
    // `role="button"` inside an `<li data-thread-item>`.
    const row = new FakeElement([]);
    const toolbarButton = new FakeElement([]);
    installDocument({
      registry: {
        '[data-app-sidebar] [data-thread-item] [role="button"]': row,
        '[data-app-sidebar] [data-sidebar="menu-button"]': toolbarButton,
      },
    });
    expect(focusPane("sidebar")).toBe(true);
    expect(row.focusCalls).toBe(1);
    expect(toolbarButton.focusCalls).toBe(0);
  });

  it("takes the toolbar only when the list has no row at all", () => {
    // An empty sidebar still has to be enterable, or `Ctrl+H` would look
    // broken to somebody with no threads yet.
    const toolbarButton = new FakeElement([]);
    installDocument({
      registry: { '[data-app-sidebar] [data-sidebar="menu-button"]': toolbarButton },
    });
    expect(focusPane("sidebar")).toBe(true);
    expect(toolbarButton.focusCalls).toBe(1);
  });

  it("focuses the composer for the chat, which is a contenteditable and not an input", () => {
    const composer = new FakeElement([]);
    installDocument({
      registry: { '[data-chat-column-maximized-away] [contenteditable="true"]': composer },
    });
    expect(focusPane("chat")).toBe(true);
    expect(composer.focusCalls).toBe(1);
  });

  it("focuses the drawer's helper textarea for the terminal", () => {
    const textarea = new FakeElement([]);
    installDocument({
      registry: { '[data-terminal-owner="drawer"] textarea': textarea },
    });
    expect(focusPane("terminal")).toBe(true);
    expect(textarea.focusCalls).toBe(1);
  });

  it("reports false, and focuses nothing, when a pane offers no entry", () => {
    installDocument({ registry: {} });
    for (const pane of ["sidebar", "chat", "panel", "terminal"] as const) {
      expect(focusPane(pane)).toBe(false);
    }
  });

  it("asks for the panel's own entries before any generic focusable", () => {
    const generic = new FakeElement([]);
    installDocument({
      registry: { "[data-preview-panel-mode] button": generic },
    });
    expect(focusPane("panel")).toBe(true);
    expect(queried.indexOf("[data-preview-panel-mode] input")).toBeLessThan(
      queried.indexOf("[data-preview-panel-mode] button"),
    );
  });
});

describe("isSidebarSearchFocused", () => {
  /**
   * The sidebar's `j` and `k` are the only bare-letter chords in the app, so
   * something has to say when the sidebar has the keyboard but a letter is
   * meant to be a letter. That is any text entry inside it, not one named
   * search box: the thread search and the project filter are two different
   * inputs and a rule keyed to one would silently stop guarding the other.
   */
  function focused(element: FakeElement | null): void {
    installDocument({ activeElement: element });
  }

  function inSidebar(element: FakeElement): FakeElement {
    element.parent = sidebarRoot();
    return element;
  }

  it("is true for the text entries the sidebar renders", () => {
    for (const tag of ["INPUT", "TEXTAREA"]) {
      focused(inSidebar(new FakeElement([], tag)));
      expect(isSidebarSearchFocused()).toBe(true);
    }
  });

  it("is true for a contenteditable, whatever tag it wears", () => {
    const editable = inSidebar(new FakeElement([], "DIV"));
    editable.isContentEditable = true;
    focused(editable);
    expect(isSidebarSearchFocused()).toBe(true);
  });

  it("is false for a thread row, which is the case j exists for", () => {
    focused(inSidebar(new FakeElement([], "BUTTON")));
    expect(isSidebarSearchFocused()).toBe(false);
  });

  it("is false for an input in another pane", () => {
    const outside = new FakeElement([], "INPUT");
    outside.parent = panelRoot();
    focused(outside);
    expect(isSidebarSearchFocused()).toBe(false);
  });

  it("is false when nothing has the keyboard, and where there is no document", () => {
    focused(null);
    expect(isSidebarSearchFocused()).toBe(false);
  });
});
