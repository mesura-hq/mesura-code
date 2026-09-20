import { afterEach, describe, expect, it } from "vite-plus/test";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import {
  createPaneFocusGuard,
  createPaneNavigationHandler,
  createSidebarListFocusClaim,
  registerPaneNavigation,
} from "./usePaneNavigation";

/**
 * A hand-built focus tree, because this workspace installs no DOM for tests.
 * Mirrors paneFocus.test.ts, which established the shape.
 */
/** Set by `installWorkspace` so focusing really moves the keyboard. */
let focusSink: ((element: FakeElement) => void) | null = null;

class FakeElement {
  isConnected = true;
  parent: FakeElement | null = null;
  focusCalls = 0;
  /** Every real element has one, and the preview check reads it. */
  tagName = "DIV";
  readonly dataset: Record<string, string | undefined> = {};

  constructor(readonly selectors: ReadonlyArray<string> = []) {}

  closest(selector: string): FakeElement | null {
    return closestFrom(this, selector);
  }

  focus(): void {
    this.focusCalls += 1;
    focusSink?.(this);
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

const SIDEBAR = "[data-app-sidebar]";
const SIDEBAR_STATE_HOST = '[data-slot="sidebar"]';
const CHAT = "[data-chat-column-maximized-away]";
const PANEL = "[data-preview-panel-mode]";
const CHAT_ENTRY = '[data-chat-column-maximized-away] [contenteditable="true"]';
const PANEL_ENTRY = "[data-preview-panel-mode] input";
const DRAWER = '[data-terminal-owner="drawer"]';
const DRAWER_ENTRY = '[data-terminal-owner="drawer"] textarea';
const SIDEBAR_ENTRY = '[data-app-sidebar] [data-sidebar="menu-button"]';

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

interface Workspace {
  readonly entries: Record<string, FakeElement>;
  focusInto(pane: "sidebar" | "chat" | "panel" | "terminal" | "none"): void;
  readonly body: FakeElement;
  /** Carries `data-state`, as the real sidebar's parent does. */
  readonly sidebarStateHost: FakeElement;
  readonly chatRoot: FakeElement;
}

/**
 * Installs the three panes, each with the entry element focusing it lands on.
 * `sidebarCollapsed` and `panelPresent` are the two ways a pane goes away.
 */
function installWorkspace(
  options: { sidebarCollapsed?: boolean; panelPresent?: boolean; drawerOpen?: boolean } = {},
): Workspace {
  const sidebarStateHost = new FakeElement([SIDEBAR_STATE_HOST]);
  sidebarStateHost.dataset.state = options.sidebarCollapsed === true ? "collapsed" : "expanded";
  const sidebar = new FakeElement([SIDEBAR]);
  sidebar.parent = sidebarStateHost;

  const chat = new FakeElement([CHAT]);
  chat.dataset.chatColumnMaximizedAway = "false";

  const panel = new FakeElement([PANEL]);
  panel.dataset.previewPanelMode = "inline";

  // The drawer is a child of the chat column, as it is in the app.
  const drawer = new FakeElement([DRAWER, "[data-terminal-owner]"]);
  drawer.dataset.terminalOwner = "drawer";
  drawer.parent = chat;
  const drawerEntry = new FakeElement([]);
  drawerEntry.parent = drawer;

  const sidebarEntry = new FakeElement([]);
  sidebarEntry.parent = sidebar;
  const chatEntry = new FakeElement([]);
  chatEntry.parent = chat;
  const panelEntry = new FakeElement([]);
  panelEntry.parent = panel;

  const body = new FakeElement([]);

  const roots: Record<string, FakeElement | undefined> = {
    [SIDEBAR]: sidebar,
    [CHAT]: chat,
    ...(options.panelPresent === false ? {} : { [PANEL]: panel }),
    ...(options.drawerOpen === true ? { [DRAWER]: drawer } : {}),
  };
  const entries: Record<string, FakeElement> = {
    [SIDEBAR_ENTRY]: sidebarEntry,
    [CHAT_ENTRY]: chatEntry,
    ...(options.panelPresent === false ? {} : { [PANEL_ENTRY]: panelEntry }),
    ...(options.drawerOpen === true ? { [DRAWER_ENTRY]: drawerEntry } : {}),
  };

  const documentLike = {
    activeElement: body as unknown as Element,
    body: body as unknown as HTMLElement,
    querySelector: (selector: string) => roots[selector] ?? entries[selector] ?? null,
  };

  globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
  globalThis.document = documentLike as unknown as Document;
  focusSink = (element) => {
    documentLike.activeElement = element as unknown as Element;
  };

  return {
    entries: {
      sidebar: sidebarEntry,
      chat: chatEntry,
      panel: panelEntry,
      terminal: drawerEntry,
    },
    body,
    sidebarStateHost,
    chatRoot: chat,
    focusInto(pane) {
      documentLike.activeElement = (pane === "sidebar"
        ? sidebarEntry
        : pane === "chat"
          ? chatEntry
          : pane === "panel"
            ? panelEntry
            : pane === "terminal"
              ? drawerEntry
              : body) as unknown as Element;
    },
  };
}

/** Collapses the sidebar the way the app does: in place, nothing unmounts. */
function collapseSidebarInPlace(workspace: Workspace): void {
  workspace.sidebarStateHost.dataset.state = "collapsed";
}

/** Maximizes the right panel over the chat column, in place. */
function maximizeChatAway(workspace: Workspace): void {
  workspace.chatRoot.dataset.chatColumnMaximizedAway = "true";
}

interface RecordedEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  prevented: number;
  stopped: number;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

function keydown(key: string, modifiers: Partial<RecordedEvent> = {}): RecordedEvent {
  const recorded: RecordedEvent = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    prevented: 0,
    stopped: 0,
    preventDefault() {
      recorded.prevented += 1;
      recorded.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      recorded.stopped += 1;
    },
    ...modifiers,
  };
  return recorded;
}

/** Built per call rather than once, so a failure lands inside a test. */
const handler = (event: RecordedEvent): void =>
  createPaneNavigationHandler({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    platform: "Linux",
  })(event);

afterEach(() => {
  focusSink = null;
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

describe("horizontal pane navigation", () => {
  it("moves right out of the chat and into the panel", () => {
    const workspace = installWorkspace();
    workspace.focusInto("chat");

    const event = keydown("l", { ctrlKey: true });
    handler(event);

    expect(workspace.entries.panel?.focusCalls).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(event.stopped).toBe(1);
  });

  it("moves left out of the chat and into the sidebar", () => {
    const workspace = installWorkspace();
    workspace.focusInto("chat");

    handler(keydown("h", { ctrlKey: true }));

    expect(workspace.entries.sidebar?.focusCalls).toBe(1);
  });

  it("does nothing at the right edge, and still refuses to pass the chord on", () => {
    // Consumed but inert: the application owns this chord in every pane, so
    // letting it fall through at the edge would give it a second meaning.
    const workspace = installWorkspace();
    workspace.focusInto("panel");

    const event = keydown("l", { ctrlKey: true });
    handler(event);

    expect(workspace.entries.panel?.focusCalls).toBe(0);
    expect(workspace.entries.chat?.focusCalls).toBe(0);
    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does nothing at the left edge", () => {
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");

    const event = keydown("h", { ctrlKey: true });
    handler(event);

    expect(workspace.entries.chat?.focusCalls).toBe(0);
    expect(event.defaultPrevented).toBe(true);
  });

  it("skips a pane that is not there and lands on the one beyond it", () => {
    const workspace = installWorkspace({ panelPresent: false });
    workspace.focusInto("chat");

    handler(keydown("l", { ctrlKey: true }));
    expect(workspace.entries.panel?.focusCalls).toBe(0);

    workspace.focusInto("chat");
    handler(keydown("h", { ctrlKey: true }));
    expect(workspace.entries.sidebar?.focusCalls).toBe(1);
  });

  it("skips a collapsed sidebar rather than focusing something off-screen", () => {
    const workspace = installWorkspace({ sidebarCollapsed: true });
    workspace.focusInto("chat");

    const event = keydown("h", { ctrlKey: true });
    handler(event);

    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
    expect(event.defaultPrevented).toBe(true);
  });

  it("moves from the pane focus was last in when nothing holds it now", () => {
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    handler(keydown("l", { ctrlKey: true }));
    expect(workspace.entries.chat?.focusCalls).toBe(1);

    // Leaving Neovim's normal mode blurs to the body. The chord still has to
    // mean something from there.
    workspace.focusInto("none");
    handler(keydown("l", { ctrlKey: true }));
    expect(workspace.entries.panel?.focusCalls).toBe(1);
  });

  it("leaves every other chord alone", () => {
    const workspace = installWorkspace();
    workspace.focusInto("chat");

    for (const event of [
      keydown("h"),
      keydown("l"),
      keydown("h", { ctrlKey: true, shiftKey: true }),
      keydown("k", { ctrlKey: true }),
      keydown("j", { ctrlKey: true }),
      keydown("b", { ctrlKey: true }),
    ]) {
      handler(event);
      expect(event.defaultPrevented).toBe(false);
      expect(event.stopped).toBe(0);
    }
    expect(workspace.entries.panel?.focusCalls).toBe(0);
    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
  });

  it("ignores an autorepeat, a composition, and an event somebody already took", () => {
    const workspace = installWorkspace();
    workspace.focusInto("chat");

    for (const event of [
      keydown("l", { ctrlKey: true, repeat: true }),
      keydown("l", { ctrlKey: true, isComposing: true }),
      keydown("l", { ctrlKey: true, defaultPrevented: true }),
    ]) {
      handler(event);
      expect(event.prevented).toBe(0);
    }
    expect(workspace.entries.panel?.focusCalls).toBe(0);
  });
});

describe("focus guard", () => {
  function guardFor() {
    const frames: Array<() => void> = [];
    const guard = createPaneFocusGuard({
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
    });
    return {
      guard,
      frames,
      runFrames: () => {
        const pending = frames.splice(0, frames.length);
        for (const frame of pending) frame();
      },
    };
  }

  it("rescues focus out of a sidebar that collapsed without ever blurring", () => {
    // Observed in the running app: collapsing keeps every row mounted,
    // focusable and holding the keyboard, and only slides the container
    // off-screen. No focusout fires, so a guard keyed on blur never runs and
    // the keyboard is left in a pane nobody can see.
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const { guard, runFrames } = guardFor();

    collapseSidebarInPlace(workspace);
    guard.onLayoutChange();
    runFrames();

    expect(workspace.entries.chat?.focusCalls).toBe(1);
  });

  it("checks once per frame however many mutations a collapse emits", () => {
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const { guard, frames, runFrames } = guardFor();

    collapseSidebarInPlace(workspace);
    guard.onLayoutChange();
    guard.onLayoutChange();
    guard.onLayoutChange();
    expect(frames.length).toBe(1);

    runFrames();
    expect(workspace.entries.chat?.focusCalls).toBe(1);
  });

  it("leaves a layout change that stranded nobody alone", () => {
    // Every menu and popover in the app carries `data-state`, so this runs
    // far more often than a pane actually closes.
    const workspace = installWorkspace();
    workspace.focusInto("chat");
    const { guard, runFrames } = guardFor();

    guard.onLayoutChange();
    runFrames();

    expect(workspace.entries.chat?.focusCalls).toBe(0);
    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
    expect(workspace.entries.panel?.focusCalls).toBe(0);
  });

  it("puts focus in the composer when the panel unmounts under it", () => {
    const workspace = installWorkspace();
    workspace.focusInto("panel");
    const { guard, runFrames } = guardFor();
    handler(keydown("h", { ctrlKey: true }));
    workspace.focusInto("panel");
    handler(keydown("l", { ctrlKey: true }));

    const closed = installWorkspace({ panelPresent: false });
    closed.focusInto("none");
    guard.onFocusOut({ relatedTarget: null });
    runFrames();

    expect(closed.entries.chat?.focusCalls).toBe(1);
  });

  it("leaves a pane that merely blurred alone, which is Escape in the editor", () => {
    // Leaving Neovim's normal mode blurs the editor to the body on purpose.
    // The panel is still there, so nothing has gone wrong and nothing should
    // yank the keyboard somewhere else.
    const workspace = installWorkspace();
    workspace.focusInto("panel");
    const { guard, runFrames } = guardFor();
    handler(keydown("h", { ctrlKey: true }));
    workspace.focusInto("panel");
    handler(keydown("l", { ctrlKey: true }));
    const before = workspace.entries.chat?.focusCalls ?? 0;

    workspace.focusInto("none");
    guard.onFocusOut({ relatedTarget: null });
    runFrames();

    expect(workspace.entries.chat?.focusCalls).toBe(before);
  });

  it("does nothing when focus went somewhere real", () => {
    const workspace = installWorkspace({ sidebarCollapsed: true });
    workspace.focusInto("chat");
    const { guard, runFrames } = guardFor();

    guard.onFocusOut({ relatedTarget: workspace.entries.chat ?? null });
    runFrames();

    expect(workspace.entries.chat?.focusCalls).toBe(0);
  });

  it("does nothing when something else took the keyboard in the meantime", () => {
    const workspace = installWorkspace({ sidebarCollapsed: true });
    workspace.focusInto("sidebar");
    const { guard, runFrames } = guardFor();

    // The sidebar is unreachable, but a dialog claims the keyboard before the
    // frame runs, so there is nothing stranded to rescue.
    guard.onFocusOut({ relatedTarget: null });
    workspace.focusInto("chat");
    runFrames();

    expect(workspace.entries.chat?.focusCalls).toBe(0);
  });

  it("falls past an unreachable chat to the next pane that can take focus", () => {
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const { guard, runFrames } = guardFor();

    collapseSidebarInPlace(workspace);
    maximizeChatAway(workspace);
    guard.onLayoutChange();
    runFrames();

    expect(workspace.entries.chat?.focusCalls).toBe(0);
    expect(workspace.entries.panel?.focusCalls).toBe(1);
  });
});

describe("registration", () => {
  it("takes the keydown in the capture phase, before any pane can see it", () => {
    // Capture is the whole arbitration: the chord has one meaning in every
    // pane, including inside Neovim and inside a terminal, and neither ever
    // sees it.
    const added: Array<{ type: string; capture: unknown }> = [];
    const removed: Array<{ type: string; capture: unknown }> = [];
    const fakeWindow = {
      addEventListener: (type: string, _listener: unknown, capture: unknown) => {
        added.push({ type, capture });
      },
      removeEventListener: (type: string, _listener: unknown, capture: unknown) => {
        removed.push({ type, capture });
      },
    };
    const fakeDocument = {
      addEventListener: (type: string, _listener: unknown, capture: unknown) => {
        added.push({ type, capture });
      },
      removeEventListener: (type: string, _listener: unknown, capture: unknown) => {
        removed.push({ type, capture });
      },
    };

    let observing = false;
    const unregister = registerPaneNavigation({
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      platform: "Linux",
      window: fakeWindow,
      document: fakeDocument,
      scheduleFrame: () => {},
      observeLayout: () => {
        observing = true;
        return () => {
          observing = false;
        };
      },
    });

    // Four, and every one of them in the capture phase: the pane chords and
    // the sidebar list claim each take a keydown and a focusout, and a
    // listener that bubbled would arrive after a pane had already answered.
    expect(added).toEqual([
      { type: "keydown", capture: true },
      { type: "keydown", capture: true },
      { type: "focusout", capture: true },
      { type: "focusout", capture: true },
    ]);

    expect(observing).toBe(true);

    unregister();
    expect(observing).toBe(false);
    expect(removed).toEqual([
      { type: "keydown", capture: true },
      { type: "keydown", capture: true },
      { type: "focusout", capture: true },
      { type: "focusout", capture: true },
    ]);
  });
});

describe("arbitration against other bindings", () => {
  function modShortcut(key: string) {
    return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true };
  }

  it("honours a pane chord the user rebound, rather than a hardcoded key", () => {
    // The handler gates on the chords this config binds the pane commands to.
    // A gate hardcoded to `h` and `l` would pass every test above and
    // silently stop honouring a rebind.
    const rebound = [{ command: "pane.focusRight" as const, shortcut: modShortcut("m") }];
    const reboundHandler = createPaneNavigationHandler({
      keybindings: rebound,
      platform: "Linux",
    });
    const workspace = installWorkspace();
    workspace.focusInto("chat");

    const unbound = keydown("l", { ctrlKey: true });
    reboundHandler(unbound);
    expect(workspace.entries.panel?.focusCalls).toBe(0);
    expect(unbound.defaultPrevented).toBe(false);

    reboundHandler(keydown("m", { ctrlKey: true }));
    expect(workspace.entries.panel?.focusCalls).toBe(1);
  });

  it("lets a binding that outranks the pane chord win, instead of swallowing it", () => {
    // Resolution is last-wins, so a rule later in the config beats the pane
    // default on the same chord. The handler has to resolve with the real
    // terminal and preview flags to see that, or it would consume the event
    // and the rule that should have won would never fire.
    const contested = [
      { command: "pane.focusRight" as const, shortcut: modShortcut("l") },
      {
        command: "terminal.new" as const,
        shortcut: modShortcut("l"),
        whenAst: { type: "identifier" as const, name: "terminalFocus" },
      },
    ];
    const contestedHandler = createPaneNavigationHandler({
      keybindings: contested,
      platform: "Linux",
    });

    const workspace = installWorkspace();
    // Focus inside the terminal drawer, which is what makes terminalFocus true.
    const drawer = new FakeElement(['[data-terminal-owner="drawer"]', "[data-terminal-owner]"]);
    drawer.dataset.terminalOwner = "drawer";
    const inDrawer = new FakeElement([]);
    inDrawer.parent = drawer;
    (globalThis.document as unknown as { activeElement: unknown }).activeElement = inDrawer;

    const event = keydown("l", { ctrlKey: true });
    contestedHandler(event);

    expect(event.defaultPrevented).toBe(false);
    expect(workspace.entries.panel?.focusCalls).toBe(0);
  });
});

describe("vertical pane navigation", () => {
  it("moves down from the chat into the terminal drawer", () => {
    const workspace = installWorkspace({ drawerOpen: true });
    workspace.focusInto("chat");

    const event = keydown("j", { ctrlKey: true });
    handler(event);

    expect(workspace.entries.terminal?.focusCalls).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(event.stopped).toBe(1);
  });

  it("moves up from the terminal drawer back into the chat", () => {
    const workspace = installWorkspace({ drawerOpen: true });
    workspace.focusInto("terminal");

    const event = keydown("k", { ctrlKey: true });
    handler(event);

    expect(workspace.entries.chat?.focusCalls).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets Ctrl+J through when the drawer is closed, so the toggle opens it", () => {
    // The self-disabling half of the design: a chord with no neighbour in
    // that direction is not consumed, and whatever else owns the key runs.
    // Here that is terminal.toggle, and the two readings agree — both mean
    // "go down into the terminal".
    const workspace = installWorkspace({ drawerOpen: false });
    workspace.focusInto("chat");

    const event = keydown("j", { ctrlKey: true });
    handler(event);

    expect(event.defaultPrevented).toBe(false);
    expect(event.stopped).toBe(0);
    expect(workspace.entries.terminal?.focusCalls).toBe(0);
  });

  it("lets Ctrl+K through from the chat, which has nothing above it", () => {
    const workspace = installWorkspace({ drawerOpen: true });
    workspace.focusInto("chat");

    const event = keydown("k", { ctrlKey: true });
    handler(event);

    expect(event.defaultPrevented).toBe(false);
    expect(workspace.entries.chat?.focusCalls).toBe(0);
  });

  it("leaves both vertical chords alone in the sidebar and the panel", () => {
    // Neither column has a vertical neighbour, so neither chord applies and
    // both keep whatever other meaning they have.
    for (const pane of ["sidebar", "panel"] as const) {
      const workspace = installWorkspace({ drawerOpen: true });
      workspace.focusInto(pane);
      for (const key of ["j", "k"]) {
        const event = keydown(key, { ctrlKey: true });
        handler(event);
        expect(event.defaultPrevented).toBe(false);
        expect(event.stopped).toBe(0);
      }
    }
  });

  it("still moves horizontally out of the drawer, treating it as the chat column", () => {
    const workspace = installWorkspace({ drawerOpen: true });
    workspace.focusInto("terminal");

    handler(keydown("l", { ctrlKey: true }));
    expect(workspace.entries.panel?.focusCalls).toBe(1);
  });
});

describe("two pane commands on one chord", () => {
  it("moves the way the winning binding says, not the way the first match did", () => {
    // Settings would flag this as a conflict but nothing prevents it. The
    // handler finds a pane binding to decide the chord is plausible, then
    // resolves the whole table to see who wins. Those two answers can name
    // different directions, and the winner is the one that must decide.
    const contested = [
      {
        command: "pane.focusLeft" as const,
        shortcut: {
          key: "m",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
      {
        command: "pane.focusRight" as const,
        shortcut: {
          key: "m",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ];
    const contestedHandler = createPaneNavigationHandler({
      keybindings: contested,
      platform: "Linux",
    });
    const workspace = installWorkspace();
    workspace.focusInto("chat");

    contestedHandler(keydown("m", { ctrlKey: true }));

    // pane.focusRight is last, so it wins, and focus goes right.
    expect(workspace.entries.panel?.focusCalls).toBe(1);
    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
  });
});

describe("the sidebar list claim", () => {
  /**
   * Opening a thread makes ChatView focus the composer, on every change of
   * the active thread. That is right when you clicked the row and wrong when
   * you walked to it with `j`, so the claim puts the keyboard back.
   *
   * Both bugs these cases exist for were found by a reviewer reading the
   * first version, and neither was reachable from any test that existed then.
   */
  function claimFor() {
    const frames: Array<() => void> = [];
    let clock = 1000;
    const claim = createSidebarListFocusClaim({
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      platform: "Linux",
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
      now: () => clock,
    });
    return {
      claim,
      advance: (ms: number) => {
        clock += ms;
      },
      runFrames: () => {
        const pending = frames.splice(0, frames.length);
        for (const frame of pending) frame();
      },
    };
  }

  /** ChatView's own behaviour: the composer takes the keyboard. */
  function composerSteals(workspace: Workspace, claim: ReturnType<typeof claimFor>) {
    workspace.focusInto("chat");
    claim.claim.onFocusOut({ relatedTarget: workspace.entries.chat ?? null });
  }

  it("puts the keyboard back on the sidebar after the composer takes it", () => {
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const claim = claimFor();

    claim.claim.onKeyDown(keydown("j"));
    composerSteals(workspace, claim);
    claim.runFrames();

    expect(workspace.entries.sidebar?.focusCalls).toBe(1);
  });

  it("keeps walking when the next chord arrives before the rescue frame", () => {
    // The second `j` of a fast run lands while the composer holds the
    // keyboard and the rescue has not run. The first version read that as
    // "`j` typed somewhere else", disarmed, and left the letter to be typed
    // into the draft. Moving focus back inside the capture phase is what
    // makes the sidebar's own handler see a focused sidebar a moment later.
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const claim = claimFor();

    claim.claim.onKeyDown(keydown("j"));
    workspace.focusInto("chat");
    claim.claim.onKeyDown(keydown("j"));

    expect(workspace.entries.sidebar?.focusCalls).toBe(1);
  });

  it("leaves a bare j alone when no chord armed the claim", () => {
    const workspace = installWorkspace();
    workspace.focusInto("chat");
    const claim = claimFor();

    claim.claim.onKeyDown(keydown("j"));
    claim.runFrames();

    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
  });

  it("takes the keyboard back from the chat and from nowhere else", () => {
    // A dialog, the command palette and a context menu all render outside
    // every pane root. The person opened them on purpose, and the first
    // version yanked focus out of whichever one appeared inside the window.
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const claim = claimFor();

    claim.claim.onKeyDown(keydown("j"));
    workspace.focusInto("none");
    claim.claim.onFocusOut({ relatedTarget: workspace.body });
    claim.runFrames();

    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
  });

  it("stops waiting after any key that is not a list chord", () => {
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const claim = claimFor();

    claim.claim.onKeyDown(keydown("j"));
    claim.claim.onKeyDown(keydown("q"));
    composerSteals(workspace, claim);
    claim.runFrames();

    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
  });

  it("stops waiting once the window has passed", () => {
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const claim = claimFor();

    claim.claim.onKeyDown(keydown("j"));
    claim.advance(601);
    composerSteals(workspace, claim);
    claim.runFrames();

    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
  });

  it("does not fight a sidebar that closed under it", () => {
    const workspace = installWorkspace({ sidebarCollapsed: true });
    workspace.focusInto("sidebar");
    const claim = claimFor();

    claim.claim.onKeyDown(keydown("j"));
    composerSteals(workspace, claim);
    claim.runFrames();

    expect(workspace.entries.sidebar?.focusCalls).toBe(0);
  });

  it("arms on the page chords too, not only the letters", () => {
    const workspace = installWorkspace();
    workspace.focusInto("sidebar");
    const claim = claimFor();

    claim.claim.onKeyDown(keydown("d", { ctrlKey: true }));
    composerSteals(workspace, claim);
    claim.runFrames();

    expect(workspace.entries.sidebar?.focusCalls).toBe(1);
  });
});
