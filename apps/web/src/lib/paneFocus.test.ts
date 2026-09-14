import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  PANE_ORDER,
  focusPane,
  getFocusedPane,
  getLastFocusedPane,
  isPaneReachable,
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
  readonly dataset: Record<string, string | undefined> = {};

  constructor(readonly selectors: ReadonlyArray<string> = []) {}

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

  it("focuses the active thread row in the sidebar, in preference to the first row", () => {
    const active = new FakeElement([]);
    const first = new FakeElement([]);
    installDocument({
      registry: {
        '[data-app-sidebar] [data-sidebar="menu-button"][data-active="true"]': active,
        '[data-app-sidebar] [data-sidebar="menu-button"]': first,
      },
    });
    expect(focusPane("sidebar")).toBe(true);
    expect(active.focusCalls).toBe(1);
    expect(first.focusCalls).toBe(0);
  });

  it("focuses the first thread row when no row is active", () => {
    const first = new FakeElement([]);
    installDocument({
      registry: { '[data-app-sidebar] [data-sidebar="menu-button"]': first },
    });
    expect(focusPane("sidebar")).toBe(true);
    expect(first.focusCalls).toBe(1);
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
