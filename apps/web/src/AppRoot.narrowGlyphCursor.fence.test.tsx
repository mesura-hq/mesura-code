// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - reads the app's stylesheets off the checkout, outside any Effect.
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout, as `routes/__root.tsx`
 * does, and whose chat layout is the real `_chat.tsx` route component (the
 * real KeyEngineHost, which draws the block cursor overlay, around the real
 * ChatView, and in it the real ChatComposer with its real Vim adapter). The
 * key engine is installed on `window` before React renders, as `main.tsx`
 * does. Keys are real `keydown` events dispatched from the focused element.
 *
 * Phase 7 of the modal keys production cycle (a readable block cursor on
 * narrow glyphs), in the chat buffer and in the composer:
 * - Criterion 1: on a glyph narrower than 0.5em the cursor is an overlay
 *   0.5em wide, centred on the glyph, drawn instead of the highlight.
 * - Criterion 2: the glyph under the widened cursor is drawn in
 *   `var(--background)`, in the glyph's own computed font family, size,
 *   weight and style.
 * - Criterion 3, guard: on a glyph 0.5em or wider the highlight paints the
 *   cursor as in the baseline, and no overlay is drawn. The composer's
 *   empty-line overlay stays as it is.
 * - Criterion 4: the widened cursor's background resolves to the highlight
 *   cursor's background, in the light and the dark theme.
 * - Criterion 5: the widened cursor follows a scroll, and a held `l` moves
 *   it, with no animation frame in between.
 * `keys/blockCursor.test.ts` covers the geometry decision exhaustively, and
 * `tests/unit/modal-keys-block-cursor-static.test.ts` guards criterion 6.
 *
 * The contract these specs read from the DOM:
 * - The widened cursor is the element `[data-mesura-block-cursor="glyph"]`,
 *   with inline `left`, `top`, `width` and `height` (px, or em against its
 *   own inline font size). It is drawn in the glyph's own container (the
 *   chat row, the composer editor's host), placed from an anchor there; an
 *   element box is empty in happy-dom, so its inline `left` and `top` read as
 *   viewport coordinates here.
 * - A colour is read from the element's inline style, else from the last
 *   `mesura.css` rule that matches it; `var()` resolves through the custom
 *   properties `index.css` and `mesura.css` declare for the theme. happy-dom
 *   drops an inline `oklch()` colour, so a literal colour has to live in
 *   `mesura.css`, where the highlight's colour already is.
 *
 * Geometry is stubbed, because happy-dom has no layout: a one-character range
 * inside the text node `GLYPH_LINE` has the box `GLYPH_WIDTHS` gives it, the
 * element that holds that text node computes the font `GLYPH_FONT`, and the
 * virtual list's wrapper is a scroll container. Every other range has no box,
 * so a fresh chat cursor starts on `GLYPH_LINE`, the only line with one.
 *
 * Boundaries the fixture replaces, and nothing else: the environment and
 * thread reads, every RPC command and query, the chords (the shipped
 * defaults), unrelated chrome, the CSS highlight registry happy-dom lacks
 * (recorded instead of painted), the sidebar's thread list, the file manager
 * layer, the virtual list's measurement, and the layout reads named above.
 * The setup follows `AppRoot.composerUndo.fence.test.tsx`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  threads: new Map<string, Thread>(),
  openThreadId: "",
  vimMode: false,
  empty: [],
  threadListeners: new Set<() => void>(),
  /** The ranges the key surfaces last painted, by highlight name. */
  highlights: new Map<string, ReadonlyArray<Range>>(),
  /** The stubbed viewport top of `GLYPH_LINE`; a scroll moves it. */
  glyphTop: 200,
  /** A horizontal shift of `GLYPH_LINE`, as a pane resize reflows the column. */
  glyphShift: 0,
  /** The composer editor's stubbed box: the whole window unless a spec scrolls it. */
  editorBox: null as { left: number; top: number; width: number; height: number } | null,
  /** Every live `ResizeObserver` and the elements it observes. */
  resizeObservers: new Map<ResizeObserverCallback, Set<Element>>(),
  project: {
    id: "narrow-cursor-project",
    environmentId: "narrow-cursor-environment",
    title: "Narrow cursor",
    workspaceRoot: "/tmp/narrow-cursor",
    scripts: [],
    createdAt: "2026-10-08T12:00:00.000Z",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  },
  environments: [
    {
      environmentId: "narrow-cursor-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          label: "Fence environment",
          connectionId: "saved:narrow-cursor-environment",
        },
      },
      displayUrl: null,
      relayManaged: false,
      serverConfig: {
        settings: {},
        environment: {
          capabilities: { threadSettlement: true, threadPinning: true },
          platform: { machine: "laptop" },
        },
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-10-08T12:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
      },
    },
  ],
}));

const success = () => Promise.resolve({ _tag: "Success" as const, value: { providers: [] } });

vi.mock("./state/entities", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const threadFor = (ref: { readonly threadId: string } | null | undefined) =>
    (ref ? fixture.threads.get(ref.threadId) : undefined) ?? null;
  const useFixtureThread = (ref: { readonly threadId: string } | null | undefined) =>
    useSyncExternalStore(
      (listener) => {
        fixture.threadListeners.add(listener);
        return () => {
          fixture.threadListeners.delete(listener);
        };
      },
      () => threadFor(ref),
    );
  return {
    ...(await importOriginal<typeof import("./state/entities")>()),
    useThread: useFixtureThread,
    readThread: threadFor,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useThreadShells: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => fixture.project,
  };
});
vi.mock("./state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments, isReady: true }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("./state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: () => undefined,
  }),
}));
vi.mock("./state/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/queries")>()),
  useThreadSearch: () => ({ matches: [], isPending: false }),
  useProjectPathSearch: () => ({ entries: [], isPending: false, error: null, truncated: false }),
}));
vi.mock("./state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => success }));
vi.mock("./state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => success }));
// The chords the app ships, as a keybindings file with no user rules resolves them.
vi.mock("./state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/server")>();
  const { Atom } = await import("effect/unstable/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(() => DEFAULT_RESOLVED_KEYBINDINGS) };
});
vi.mock("./hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const clientSettings = () => ({ ...DEFAULT_CLIENT_SETTINGS, vimMode: fixture.vimMode });
  return {
    ...(await importOriginal<typeof import("./hooks/useSettings")>()),
    useEnvironmentSettings: () => ({ ...clientSettings(), ...DEFAULT_SERVER_SETTINGS }),
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(clientSettings()) : clientSettings(),
    useClientSettingsHydrated: () => true,
    useLegacySidebarEnabled: () => false,
  };
});
vi.mock("./hooks/useHandleNewThread", async () => {
  const { scopeThreadRef: scope } = await import("@t3tools/client-runtime/environment");
  const { EnvironmentId: Env, ThreadId: Thr } = await import("@t3tools/contracts");
  return {
    useNewThreadHandler: () => success,
    useHandleNewThread: () => ({
      activeDraftThread: null,
      activeThread: fixture.threads.get(fixture.openThreadId) ?? null,
      defaultProjectRef: null,
      handleNewThread: success,
      routeDraftId: null,
      routeThreadRef: scope(Env.make("narrow-cursor-environment"), Thr.make(fixture.openThreadId)),
    }),
  };
});
vi.mock("./hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: success,
    pinThread: success,
    confirmAndUnpinThread: success,
  }),
}));
// The sidebar's thread list, reduced to the open thread's row.
vi.mock("./components/Sidebar", () => ({
  default: () => (
    <ul>
      <li data-thread-item="" data-thread-key="narrow-cursor-row">
        <div role="button" tabIndex={0} data-testid="sidebar-thread-row">
          Narrow cursor
        </div>
      </li>
    </ul>
  ),
}));
vi.mock("./components/LegacySidebar", () => ({ default: () => null }));
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("./components/files/mesuraFileManager/MesuraFileManagerLayer", () => ({
  MesuraFileManagerLayer: () => null,
}));
// happy-dom has no CSS Custom Highlight API. Record what would be painted.
vi.mock("./keys/highlights", () => ({
  paintHighlight: (name: string, ranges: readonly Range[]) => {
    fixture.highlights.set(
      name,
      ranges.map((range) => range.cloneRange()),
    );
  },
}));
// happy-dom has no layout. Keep routing and timeline projection real, and
// replace only the virtual list's measurement boundary. Its wrapper is the
// timeline's scroll container: taller content than its own height, and
// `overflow-y: auto` through the stubbed computed style.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: Array<{ id: string }>;
    renderItem: (input: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div
      data-fence-scroller=""
      ref={(element) => {
        if (!element) return;
        Object.defineProperty(element, "scrollHeight", { configurable: true, value: 2000 });
        Object.defineProperty(element, "clientHeight", { configurable: true, value: 500 });
      }}
    >
      {ListHeaderComponent}
      {data.map((item) => (
        <div key={item.id}>{renderItem({ item })}</div>
      ))}
      {ListFooterComponent}
    </div>
  ),
}));

import { AppRoot } from "./AppRoot";
import { AppSidebarLayout } from "./components/AppSidebarLayout";
import { CommandPalette } from "./components/CommandPalette";
import ChatView from "./components/ChatView";
import { useComposerDraftStore } from "./composerDraftStore";
import { composerEditorElement } from "./keys/focusScope";
import { installKeyEngine } from "./keys/keyEngine";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { readAssistantText } from "./lib/assistantTextSelection";
import { Route as ChatLayoutRoute } from "./routes/_chat";

const environmentId = EnvironmentId.make("narrow-cursor-environment");
const now = "2026-10-08T12:00:00.000Z";
let root: Root | undefined;
let router: ReturnType<typeof createFixtureRouter> | undefined;
let container: HTMLDivElement;
let threadSequence = 0;

/**
 * The text both surfaces show: a wide glyph, three narrow ones, and one
 * exactly half an em wide. Its cursor walks left to right with `l`.
 */
const GLYPH_LINE = "Wil.0";
const GLYPH_FONT_SIZE_PX = 20;
const HALF_EM_PX = GLYPH_FONT_SIZE_PX / 2;
/** Each glyph's stubbed width in px, at `GLYPH_FONT_SIZE_PX`. */
const GLYPH_WIDTHS: Readonly<Record<string, number>> = {
  W: 13,
  i: 4,
  l: 4,
  ".": 4,
  "0": HALF_EM_PX,
};
const GLYPH_LINE_LEFT = 300;
const GLYPH_HEIGHT = 24;
/** The computed font of the element that holds `GLYPH_LINE`. */
const GLYPH_FONT = {
  "font-family": '"Fence Serif", serif',
  "font-size": `${GLYPH_FONT_SIZE_PX}px`,
  "font-weight": "600",
  "font-style": "italic",
} as const;
const NARROW_GLYPHS = ["i", "l", "."] as const;

/** The stubbed box of `GLYPH_LINE`'s character at `index`. */
function glyphBox(index: number): { left: number; top: number; width: number; height: number } {
  let left = GLYPH_LINE_LEFT + fixture.glyphShift;
  for (const character of GLYPH_LINE.slice(0, index)) left += GLYPH_WIDTHS[character]!;
  return {
    left,
    top: fixture.glyphTop,
    width: GLYPH_WIDTHS[GLYPH_LINE[index]!]!,
    height: GLYPH_HEIGHT,
  };
}

/** The box a one-character range inside `GLYPH_LINE` has; null for any other range. */
function stubbedRangeBox(range: Range): DOMRect | null {
  const node = range.startContainer;
  if (node !== range.endContainer || node.nodeType !== Node.TEXT_NODE) return null;
  if ((node as Text).data !== GLYPH_LINE) return null;
  if (range.endOffset - range.startOffset !== 1) return null;
  const box = glyphBox(range.startOffset);
  return new DOMRect(box.left, box.top, box.width, box.height);
}

const holdsGlyphLine = (element: Element) =>
  [...element.childNodes].some(
    (child) => child.nodeType === Node.TEXT_NODE && (child as Text).data === GLYPH_LINE,
  );

const CSS_PROPERTY_NAMES: Readonly<Record<string, string>> = {
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  fontStyle: "font-style",
  overflowY: "overflow-y",
};

/** A computed style with some properties replaced, read by name or by `getPropertyValue`. */
function overriddenStyle(
  style: CSSStyleDeclaration,
  overrides: Readonly<Record<string, string>>,
): CSSStyleDeclaration {
  return new Proxy(style, {
    get(target, property) {
      if (property === "getPropertyValue") {
        return (name: string) => overrides[name] ?? target.getPropertyValue(name);
      }
      if (typeof property === "string") {
        const cssName = CSS_PROPERTY_NAMES[property];
        if (cssName && overrides[cssName] !== undefined) return overrides[cssName];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function stubLayout() {
  const rangeBoundingRect = Range.prototype.getBoundingClientRect;
  const rangeClientRects = Range.prototype.getClientRects;
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    return stubbedRangeBox(this) ?? rangeBoundingRect.call(this);
  });
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const box = stubbedRangeBox(this);
    if (box === null) return rangeClientRects.call(this);
    return Object.assign([box], { item: (index: number) => (index === 0 ? box : null) });
  });
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computedStyle(element, pseudo);
    if (holdsGlyphLine(element)) return overriddenStyle(style, GLYPH_FONT);
    // The timeline's scroll container, and the composer editor, which
    // scrolls inside its host (`overflow-y-auto`).
    if (
      element.hasAttribute("data-fence-scroller") ||
      element.getAttribute("data-testid") === "composer-editor"
    ) {
      return overriddenStyle(style, { "overflow-y": "auto" });
    }
    return style;
  });
  const elementBoundingRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const box = fixture.editorBox;
      if (box && this.getAttribute("data-testid") === "composer-editor") {
        return new DOMRect(box.left, box.top, box.width, box.height);
      }
      return elementBoundingRect.call(this);
    },
  );
  vi.stubGlobal("ResizeObserver", FixtureResizeObserver);
}

/** A `ResizeObserver` the test fires by hand: happy-dom has no layout to resize. */
class FixtureResizeObserver {
  readonly #callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    fixture.resizeObservers.set(callback, new Set());
  }
  observe(target: Element) {
    fixture.resizeObservers.get(this.#callback)?.add(target);
  }
  unobserve(target: Element) {
    fixture.resizeObservers.get(this.#callback)?.delete(target);
  }
  disconnect() {
    fixture.resizeObservers.delete(this.#callback);
  }
}

/** Reports a size change of every observed element, as a pane resize does. */
function resizeObservedElements() {
  for (const [callback, targets] of fixture.resizeObservers) {
    const entries = [...targets].map((target) => ({ target }) as ResizeObserverEntry);
    if (entries.length > 0) callback(entries, {} as ResizeObserver);
  }
}

/** How many elements the app's resize observers watch; the cursor's are told apart by difference. */
const observedElementCount = () =>
  [...fixture.resizeObservers.values()].reduce((count, targets) => count + targets.size, 0);

/** Observed elements no longer in the document: what a left thread's cursor would keep. */
const detachedObservedCount = () =>
  [...fixture.resizeObservers.values()].reduce(
    (count, targets) => count + [...targets].filter((target) => !target.isConnected).length,
    0,
  );

const composerExpanded = () => "mesuraComposerExpanded" in document.documentElement.dataset;

beforeAll(() => {
  installKeyEngine();
});

function makeMessage(id: string, role: "user" | "assistant", text: string) {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** Registers a thread whose reply is `GLYPH_LINE`, with an id no other test uses. */
function addGlyphThread(label: string): ThreadId {
  threadSequence += 1;
  const id = ThreadId.make(`narrow-cursor-${label}-${threadSequence}`);
  fixture.threads.set(id, {
    id,
    environmentId,
    projectId: ProjectId.make("narrow-cursor-project"),
    title: `Narrow cursor ${label}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [
      makeMessage(`${id}-user`, "user", `Question for ${label}`),
      makeMessage(`${id}-assistant`, "assistant", GLYPH_LINE),
    ],
    proposedPlans: [],
    checkpoints: [],
    pullRequests: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    activities: [],
  } as unknown as Thread);
  return id;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.vimMode = false;
  fixture.glyphTop = 200;
  fixture.glyphShift = 0;
  fixture.editorBox = { left: 0, top: 0, width: 10000, height: 10000 };
  fixture.resizeObservers.clear();
  fixture.highlights.clear();
  stubLayout();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  router = undefined;
  container.remove();
  fixture.threads.clear();
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function createFixtureRouter(firstThreadId: ThreadId) {
  const route = createRootRoute({
    component: () => (
      <CommandPalette>
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      </CommandPalette>
    ),
  });
  const chatLayout = createRoute({
    getParentRoute: () => route,
    id: "_chat",
    component: ChatLayoutRoute.options.component!,
  });
  const thread = createRoute({
    getParentRoute: () => chatLayout,
    path: "/$environmentId/$threadId",
    component: function FixtureThreadRoute() {
      const params = thread.useParams();
      return (
        <ChatView
          environmentId={EnvironmentId.make(params.environmentId)}
          threadId={ThreadId.make(params.threadId)}
          routeKind="server"
        />
      );
    },
  });
  return createRouter({
    routeTree: route.addChildren([chatLayout.addChildren([thread])]),
    history: createMemoryHistory({ initialEntries: [`/${environmentId}/${firstThreadId}`] }),
  });
}

/** Mounts the app on `threadId` with Vim mode on, the chat holding the keyboard. */
async function mountApp(threadId: ThreadId) {
  fixture.vimMode = true;
  fixture.openThreadId = threadId;
  router = createFixtureRouter(threadId);
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/** Opens another thread the way the sidebar does: a navigation, with no key after it. */
async function openThread(threadId: ThreadId) {
  fixture.openThreadId = threadId;
  await act(async () => {
    await router!.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    } as never);
  });
  await settle();
  expect(
    document.querySelector(`[data-timeline-row-id*="${threadId}"]`),
    `thread ${threadId} is on screen`,
  ).not.toBeNull();
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly repeat?: boolean;
}

function keydown(chord: Chord): KeyboardEvent {
  return new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
}

/** Dispatches one keydown from the focused element, as the browser does. */
async function press(chord: Chord) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(keydown(chord));
  });
  await settle();
}

const key = (letter: string): Chord => ({
  key: letter,
  code: /^\d$/.test(letter) ? `Digit${letter}` : `Key${letter.toUpperCase()}`,
});
const ESCAPE: Chord = { key: "Escape", code: "Escape" };
const DOLLAR: Chord = { key: "$", code: "Digit4" };
const SPACE: Chord = { key: " ", code: "Space" };

/**
 * Runs `step` with animation frames that never fire, then hands back what the
 * screen shows: a cursor that waits for a frame has not moved yet.
 */
async function withinTheSameFrame(step: () => void) {
  const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  try {
    await act(async () => step());
  } finally {
    frames.mockRestore();
  }
}

/** A held `l`: the browser's auto-repeat keydown, in the same frame. */
async function holdL() {
  await withinTheSameFrame(() => {
    (document.activeElement ?? document.body).dispatchEvent(keydown({ ...key("l"), repeat: true }));
  });
}

// ── The chat ────────────────────────────────────────────────────────────────

/** Mounts a glyph thread and paints the chat cursor on `GLYPH_LINE`'s `W`. */
async function chatCursorOnGlyphLine(label: string) {
  await mountApp(addGlyphThread(label));
  // `h` at the start of a line does not move: it paints where the cursor is.
  await press(key("h"));
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  expect(paintedGlyph("mesura-chat-cursor"), "a fresh chat cursor starts on W").toBe("W");
}

function chatScroller(): HTMLElement {
  const scroller = document.querySelector<HTMLElement>("[data-fence-scroller]");
  expect(scroller, "the timeline's scroll container is mounted").not.toBeNull();
  return scroller!;
}

// ── The composer ────────────────────────────────────────────────────────────

function composer(): HTMLElement {
  const editor = composerEditorElement();
  expect(editor, "the composer editor is mounted").not.toBeNull();
  return editor!;
}

/** Puts `prompt` in the thread's draft, focuses the composer and enters normal mode. */
async function composerNormalWith(label: string, prompt: string) {
  const threadId = addGlyphThread(label);
  await mountApp(threadId);
  await act(async () =>
    useComposerDraftStore.getState().setPrompt(scopeThreadRef(environmentId, threadId), prompt),
  );
  await settle();
  await act(async () => composer().focus());
  await settle();
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
  await press(ESCAPE);
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });
}

/** Mounts a composer holding `GLYPH_LINE` in normal mode, the cursor on its `W`. */
async function composerCursorOnGlyphLine(label: string) {
  await composerNormalWith(label, GLYPH_LINE);
  await press(key("0"));
  expect(paintedGlyph("mesura-composer-cursor"), "`0` puts the composer cursor on W").toBe("W");
}

// ── Reading the cursor ──────────────────────────────────────────────────────

type CursorHighlight = "mesura-chat-cursor" | "mesura-composer-cursor";

/** The text the cursor highlight was last painted over; null when it paints nothing. */
function paintedGlyph(name: CursorHighlight): string | null {
  const ranges = fixture.highlights.get(name) ?? [];
  return ranges.length === 0 ? null : ranges.map((range) => range.toString()).join("");
}

function palette(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="command-palette"]');
}

/** The element holding the `GLYPH_LINE` text in the chat or the composer. */
function glyphHolder(surface: "chat" | "composer"): HTMLElement {
  const holders = [...document.querySelectorAll<HTMLElement>("*")].filter(holdsGlyphLine);
  const holder = holders.find((element) =>
    surface === "composer"
      ? composer().contains(element)
      : element.closest("[data-timeline-row-id]") !== null,
  );
  expect(holder, `the ${surface} shows the glyph line`).toBeDefined();
  return holder!;
}

function widenedCursor(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-mesura-block-cursor="glyph"]');
}

/** Every block cursor overlay on the page: the widened one and the empty-line one. */
function blockCursorOverlays(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      element.hasAttribute("data-mesura-block-cursor") ||
      element.classList.contains("bg-sky-500/80"),
  );
}

/** The nearest inline value of `property` from `element` up to and including `boundary`. */
function inlineStyle(element: HTMLElement, boundary: HTMLElement, property: string): string {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const value = node.style.getPropertyValue(property);
    if (value !== "") return value;
    if (node === boundary) break;
  }
  return "";
}

/** A length the overlay declares inline, in px; em resolves against its inline font size. */
function inlinePx(element: HTMLElement, property: string): number {
  const value = element.style.getPropertyValue(property);
  if (value.endsWith("px")) return Number.parseFloat(value);
  if (value.endsWith("em")) {
    const fontSize = element.style.getPropertyValue("font-size");
    expect(fontSize, `an em ${property} needs an inline px font size`).toMatch(/px$/);
    return Number.parseFloat(value) * Number.parseFloat(fontSize);
  }
  throw new Error(`the overlay's inline ${property} is not a length: "${value}"`);
}

interface PaintedBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function overlayBox(overlay: HTMLElement): PaintedBox {
  return {
    left: inlinePx(overlay, "left"),
    top: inlinePx(overlay, "top"),
    width: inlinePx(overlay, "width"),
    height: inlinePx(overlay, "height"),
  };
}

/** The widened cursor on `GLYPH_LINE[index]`: half an em, centred on the glyph, instead of the highlight. */
function expectWidenedOn(index: number, highlight: CursorHighlight) {
  const glyph = GLYPH_LINE[index]!;
  expect(paintedGlyph(highlight), `no highlight is painted under the widened ${glyph}`).toBeNull();
  const overlay = widenedCursor();
  expect(overlay, `the cursor on ${glyph} is the widened overlay`).not.toBeNull();
  expect(overlay!.textContent, "the overlay draws the glyph under it").toBe(glyph);
  const box = overlayBox(overlay!);
  const source = glyphBox(index);
  expect(box.width, `the cursor on ${glyph} is half an em wide`).toBeCloseTo(HALF_EM_PX, 6);
  expect(box.left + box.width / 2, `the cursor on ${glyph} is centred on it`).toBeCloseTo(
    source.left + source.width / 2,
    6,
  );
  expect(box.top).toBeCloseTo(source.top, 6);
  expect(box.height).toBeCloseTo(source.height, 6);
}

/** The highlight paints `glyph` as in the baseline, and no overlay is drawn. */
function expectHighlightOnly(glyph: string, highlight: CursorHighlight) {
  expect(paintedGlyph(highlight), `the highlight paints ${glyph}`).toBe(glyph);
  expect(blockCursorOverlays(), `no overlay is drawn on ${glyph}`).toEqual([]);
}

/** The element inside the overlay that draws the glyph: the deepest one holding its text. */
function overlayGlyphElement(overlay: HTMLElement): HTMLElement {
  let element = overlay;
  for (;;) {
    const inner = [...element.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.textContent === overlay.textContent,
    );
    if (!inner) return element;
    element = inner;
  }
}

function expectGlyphDrawnInItsOwnFont(overlay: HTMLElement) {
  const glyph = overlayGlyphElement(overlay);
  for (const [property, value] of Object.entries(GLYPH_FONT)) {
    expect(inlineStyle(glyph, overlay, property), `the overlay glyph's ${property}`).toBe(value);
  }
  expect(declaredStyle(glyph, overlay, "color", "light"), "the overlay glyph's colour").toBe(
    "var(--background)",
  );
}

// ── Reading the stylesheets ─────────────────────────────────────────────────

interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
}

// A `?raw` import of a stylesheet comes back empty under the web test config.
const readStylesheet = (fileName: "index.css" | "mesura.css") =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, fileName), "utf8");

function parseRules(fileName: "index.css" | "mesura.css"): CssRule[] {
  const css = readStylesheet(fileName).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // A statement such as `@import …;` before the rule is not part of its selector.
    const prelude = match[1]!.slice(match[1]!.lastIndexOf(";") + 1).trim();
    const declarations = new Map<string, string>();
    for (const declaration of match[2]!.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    rules.push({ selectors: prelude.split(",").map((selector) => selector.trim()), declarations });
  }
  return rules;
}

type Theme = "light" | "dark";
const DARK_PREFIX = /^(?::root)?\.dark\s*/;

/** The custom properties `index.css` and `mesura.css` declare for a theme, later files winning. */
function customProperties(theme: Theme): Map<string, string> {
  const properties = new Map<string, string>();
  for (const rule of [...parseRules("index.css"), ...parseRules("mesura.css")]) {
    const applies = rule.selectors.some(
      (selector) =>
        selector === ":root" ||
        selector.startsWith("@theme") ||
        (theme === "dark" && selector === ".dark"),
    );
    if (!applies) continue;
    for (const [name, value] of rule.declarations) {
      if (name.startsWith("--")) properties.set(name, value);
    }
  }
  return properties;
}

function resolveVariables(value: string, theme: Theme): string {
  const properties = customProperties(theme);
  let resolved = value;
  for (let depth = 0; depth < 10 && resolved.includes("var("); depth += 1) {
    resolved = resolved.replace(
      /var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
      (whole, name: string, fallback?: string) => properties.get(name) ?? fallback ?? whole,
    );
  }
  return resolved.replace(/\s+/g, " ").trim();
}

/** A highlight's `background-color` in `mesura.css`, for a theme, with `var()` resolved. */
function highlightBackground(name: CursorHighlight, theme: Theme): string {
  let value: string | undefined;
  for (const rule of parseRules("mesura.css")) {
    const applies = rule.selectors.some((selector) => {
      const dark = DARK_PREFIX.test(selector);
      if (dark && theme !== "dark") return false;
      return selector.replace(DARK_PREFIX, "") === `::highlight(${name})`;
    });
    if (!applies) continue;
    value = rule.declarations.get("background-color") ?? rule.declarations.get("background");
  }
  expect(value, `mesura.css gives ::highlight(${name}) a background`).toBeDefined();
  return resolveVariables(value!, theme);
}

/**
 * The value `property` takes on `element`: its inline style, else the last
 * matching `mesura.css` rule, walking up to `boundary` for an inherited
 * property such as `color`.
 */
function declaredStyle(
  element: HTMLElement,
  boundary: HTMLElement,
  property: string,
  theme: Theme,
): string {
  const rules = parseRules("mesura.css");
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const inline = node.style.getPropertyValue(property);
      if (inline !== "") return resolveVariables(inline, theme);
      let fromRule: string | undefined;
      for (const rule of rules) {
        const matches = rule.selectors.some((selector) => {
          if (selector.includes("::") || selector.startsWith("@")) return false;
          try {
            return node!.matches(selector);
          } catch {
            return false;
          }
        });
        if (matches && rule.declarations.has(property)) fromRule = rule.declarations.get(property);
      }
      if (fromRule !== undefined) {
        return property === "color" && fromRule === "var(--background)"
          ? fromRule
          : resolveVariables(fromRule, theme);
      }
      if (node === boundary) break;
    }
    return "";
  } finally {
    document.documentElement.classList.remove("dark");
  }
}

function overlayBackground(overlay: HTMLElement, theme: Theme): string {
  const background = declaredStyle(overlay, overlay, "background-color", theme);
  return background !== "" ? background : declaredStyle(overlay, overlay, "background", theme);
}

// ── Specs ───────────────────────────────────────────────────────────────────

// The specs' reds and greens are only as good as the stubs they read through.
describe("narrow glyph cursor fence: the fixture", () => {
  it("narrow glyph cursor fence fixture check: the glyph line has its stubbed boxes and font, and the highlight colour resolves", async () => {
    await chatCursorOnGlyphLine("fixture");
    const range = fixture.highlights.get("mesura-chat-cursor")![0]!;
    const holder = range.startContainer.parentElement!;
    for (const [property, value] of Object.entries(GLYPH_FONT)) {
      expect(getComputedStyle(holder).getPropertyValue(property), property).toBe(value);
    }
    expect(getComputedStyle(holder).fontSize).toBe(GLYPH_FONT["font-size"]);
    const narrow = document.createRange();
    narrow.setStart(range.startContainer, 1);
    narrow.setEnd(range.startContainer, 2);
    expect(narrow.getBoundingClientRect().toJSON()).toMatchObject(glyphBox(1));
    expect(narrow.getClientRects()[0]?.width).toBe(GLYPH_WIDTHS.i);
    for (const theme of ["light", "dark"] as const) {
      for (const name of ["mesura-chat-cursor", "mesura-composer-cursor"] as const) {
        expect(highlightBackground(name, theme), `${name} in ${theme}`).toMatch(/^oklch\(/);
      }
    }
  });
});

describe("narrow glyph cursor fence: the chat", () => {
  it("narrow glyph cursor fence spec: the chat cursor on i, l and . is a half-em overlay centred on the glyph", async () => {
    await chatCursorOnGlyphLine("chat-narrow");
    for (const glyph of NARROW_GLYPHS) {
      await press(key("l"));
      expectWidenedOn(GLYPH_LINE.indexOf(glyph), "mesura-chat-cursor");
    }
  });

  it("narrow glyph cursor fence spec: the widened chat cursor draws its glyph in var(--background) and the glyph's own font", async () => {
    await chatCursorOnGlyphLine("chat-font");
    await press(key("l"));
    const overlay = widenedCursor();
    expect(overlay, "the cursor on i is the widened overlay").not.toBeNull();
    expectGlyphDrawnInItsOwnFont(overlay!);
  });

  it("narrow glyph cursor fence spec: the widened chat cursor has the highlight cursor's colour in light and dark", async () => {
    await chatCursorOnGlyphLine("chat-colour");
    await press(key("l"));
    const overlay = widenedCursor();
    expect(overlay, "the cursor on i is the widened overlay").not.toBeNull();
    for (const theme of ["light", "dark"] as const) {
      expect(overlayBackground(overlay!, theme), `the ${theme} theme`).toBe(
        highlightBackground("mesura-chat-cursor", theme),
      );
    }
  });

  it("narrow glyph cursor fence spec: the widened chat cursor follows a scroll of the timeline in the same frame", async () => {
    await chatCursorOnGlyphLine("chat-scroll");
    await press(key("l"));
    expectWidenedOn(1, "mesura-chat-cursor");

    fixture.glyphTop = 80;
    await withinTheSameFrame(() => chatScroller().dispatchEvent(new Event("scroll")));
    expect(widenedCursor(), "the cursor stays widened after the scroll").not.toBeNull();
    expect(overlayBox(widenedCursor()!).top, "the overlay moved with the glyph").toBeCloseTo(80, 6);
    expectWidenedOn(1, "mesura-chat-cursor");
  });

  it("narrow glyph cursor fence spec: a held l moves the widened chat cursor glyph by glyph in the same frame", async () => {
    await chatCursorOnGlyphLine("chat-held");
    await press(key("l"));
    expectWidenedOn(1, "mesura-chat-cursor");
    await holdL();
    expectWidenedOn(2, "mesura-chat-cursor");
    await holdL();
    expectWidenedOn(3, "mesura-chat-cursor");
  });

  // Already true at the base, and must stay so: a guard.
  it("narrow glyph cursor fence guard: the chat cursor on a glyph half an em or wider is the highlight alone", async () => {
    await chatCursorOnGlyphLine("chat-wide");
    expectHighlightOnly("W", "mesura-chat-cursor");
    await press(DOLLAR);
    expectHighlightOnly("0", "mesura-chat-cursor");
  });
});

// Verifier finding (phase 7, verifier-1): the widened chat cursor is a fixed
// element above every layer, so the expanded composer showed it through,
// where the highlight it replaces was covered.
describe("narrow glyph cursor fence: covered cursors", () => {
  it("narrow glyph cursor fence regression: the expanded composer covers the widened chat cursor, and collapsing it shows the cursor again", async () => {
    await chatCursorOnGlyphLine("chat-covered");
    await press(key("l"));
    expectWidenedOn(1, "mesura-chat-cursor");

    await act(async () => composer().focus());
    await settle();
    await press(ESCAPE);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });
    await press(SPACE);
    await press(key("e"));
    expect(composerExpanded(), "Space e expands the composer").toBe(true);
    // Review P1-2 replaced the hit test with drawing in the glyph's own row:
    // the composer paints over that row, so it covers the cursor as it covers
    // the glyph. The cursor never moves above every layer.
    expectInGlyphRow(widenedCursor(), "under the expanded composer");

    await press(SPACE);
    await press(key("e"));
    expect(composerExpanded(), "Space e collapses the composer").toBe(false);
    expect(widenedCursor()?.textContent, "the chat cursor shows again on i").toBe("i");
  });
});

// Verifier finding (phase 7, verifier-2): closing the command palette over a
// widened chat cursor left it hidden, because focus returned to <body> and no
// event the cursor followed fired.
describe("narrow glyph cursor fence: closed layers", () => {
  it("narrow glyph cursor fence regression: the command palette hides the widened chat cursor, and closing it shows the cursor again", async () => {
    await chatCursorOnGlyphLine("chat-palette");
    await press(key("l"));
    expectWidenedOn(1, "mesura-chat-cursor");

    await press(SPACE);
    await press(key("f"));
    await press(key("c"));
    expect(palette(), "Space f c opens the command palette").not.toBeNull();
    // Review P1-2: the palette's portal paints over the row, and the cursor in it.
    expectInGlyphRow(widenedCursor(), "under the palette");
    expect(palette()!.contains(widenedCursor()), "the cursor is not in the palette").toBe(false);

    await press(ESCAPE);
    expect(palette(), "Escape closes the command palette").toBeNull();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
    expect(widenedCursor()?.textContent, "the chat cursor shows again on i").toBe("i");
  });
});

/** The widened chat cursor is drawn inside the glyph's own row, on `i`. */
function expectInGlyphRow(overlay: HTMLElement | null, when: string) {
  expect(overlay?.textContent, `the chat cursor is on i ${when}`).toBe("i");
  expect(
    overlay!.closest("[data-timeline-row-id]"),
    `the cursor is in the glyph's row ${when}`,
  ).toBe(glyphHolder("chat").closest("[data-timeline-row-id]"));
}

// Review P1-1: a pane resize reflows the glyph with no scroll, focus or key.
describe("narrow glyph cursor fence: pane resizing", () => {
  it("narrow glyph cursor fence regression: resizing a pane re-places the widened chat cursor with no scroll, focus or key", async () => {
    await chatCursorOnGlyphLine("chat-resize");
    const onWideGlyph = observedElementCount();
    await press(key("l"));
    expectWidenedOn(1, "mesura-chat-cursor");
    expect(
      observedElementCount(),
      "the widened cursor follows its container's size",
    ).toBeGreaterThan(onWideGlyph);

    fixture.glyphShift = -40;
    await withinTheSameFrame(resizeObservedElements);
    expectWidenedOn(1, "mesura-chat-cursor");
  });

  it("narrow glyph cursor fence regression: a cursor that leaves the narrow glyphs stops observing sizes", async () => {
    await chatCursorOnGlyphLine("chat-resize-stop");
    const onWideGlyph = observedElementCount();
    await press(key("l"));
    expect(observedElementCount()).toBeGreaterThan(onWideGlyph);
    await press(DOLLAR);
    expectHighlightOnly("0", "mesura-chat-cursor");
    expect(observedElementCount(), "nothing more is observed for a wide glyph").toBe(onWideGlyph);
  });
});

// Review P1-2: a fixed overlay above every layer escaped the clipping and the
// covering the glyph's own highlight gets.
describe("narrow glyph cursor fence: clipping and covering", () => {
  it("narrow glyph cursor fence regression: the widened chat cursor renders inside the glyph's own row, under the timeline's clipping and layers", async () => {
    await chatCursorOnGlyphLine("chat-context");
    await press(key("l"));
    const overlay = widenedCursor();
    expect(overlay, "the cursor on i is the widened overlay").not.toBeNull();
    const glyphRow = glyphHolder("chat").closest("[data-timeline-row-id]");
    expect(overlay!.closest("[data-timeline-row-id]"), "the overlay is in the glyph's row").toBe(
      glyphRow,
    );
    expect(chatScroller().contains(overlay), "the timeline's scroll container clips it").toBe(true);
    expect(overlay!.classList.contains("fixed"), "the overlay is not fixed above every layer").toBe(
      false,
    );
    expect(glyphHolder("chat").contains(overlay), "the overlay is not in the text itself").toBe(
      false,
    );
  });

  it("narrow glyph cursor fence regression: the widened chat cursor in a row adds nothing to the row's text projection", async () => {
    await chatCursorOnGlyphLine("chat-projection");
    const row = glyphHolder("chat").closest<HTMLElement>("[data-timeline-row-id]")!;
    const before = readAssistantText(row).text;
    await press(key("l"));
    expect(row.contains(widenedCursor()), "the cursor is drawn in the row").toBe(true);
    expect(readAssistantText(row).text, "the buffer reads the row as before").toBe(before);
  });

  it("narrow glyph cursor fence regression: the widened composer cursor renders beside the editor, never inside its editable content", async () => {
    await composerCursorOnGlyphLine("composer-context");
    await press(key("l"));
    const overlay = widenedCursor();
    expect(overlay, "the cursor on i is the widened overlay").not.toBeNull();
    expect(composer().contains(overlay), "the overlay is outside the editable content").toBe(false);
    expect(composer().parentElement!.contains(overlay), "the overlay is in the editor's host").toBe(
      true,
    );
  });

  it("narrow glyph cursor fence regression: a composer glyph partly scrolled out of the editor shows only its visible part", async () => {
    await composerCursorOnGlyphLine("composer-clip");
    await press(key("l"));
    fixture.editorBox = { left: 0, top: fixture.glyphTop + 10, width: 1000, height: 500 };
    await withinTheSameFrame(() => composer().dispatchEvent(new Event("scroll")));
    const overlay = widenedCursor();
    expect(overlay, "the partly visible glyph keeps its widened cursor").not.toBeNull();
    expect(overlay!.style.getPropertyValue("clip-path"), "the clipped top is cut off").toBe(
      "inset(10px 0px 0px 0px)",
    );
  });

  it("narrow glyph cursor fence regression: a composer glyph scrolled wholly out of the editor draws no overlay", async () => {
    await composerCursorOnGlyphLine("composer-clipped-out");
    await press(key("l"));
    fixture.editorBox = { left: 0, top: fixture.glyphTop + 100, width: 1000, height: 500 };
    await withinTheSameFrame(() => composer().dispatchEvent(new Event("scroll")));
    expect(widenedCursor(), "no overlay for a glyph the editor clips away").toBeNull();
  });
});

// Review P1-3: a thread change reset the logical cursor but left its overlay
// painted and its observers connected.
describe("narrow glyph cursor fence: thread changes", () => {
  it("narrow glyph cursor fence regression: opening another thread clears the widened chat cursor and stops following it, before any key", async () => {
    await chatCursorOnGlyphLine("thread-from");
    await press(key("l"));
    expectWidenedOn(1, "mesura-chat-cursor");

    await openThread(addGlyphThread("thread-to"));
    expect(widenedCursor(), "the left thread's cursor is gone").toBeNull();
    expect(paintedGlyph("mesura-chat-cursor"), "no chat cursor is painted yet").toBeNull();
    expect(detachedObservedCount(), "nothing of the left thread is still observed").toBe(0);
  });
});

// Verifier finding (phase 7, verifier-4): returning to a thread left its
// remembered cursor unpainted until the next key.
describe("narrow glyph cursor fence: returning to a thread", () => {
  it("narrow glyph cursor fence regression: browser Back to a thread paints its remembered cursor before any key", async () => {
    await chatCursorOnGlyphLine("back-from");
    await press(key("l"));
    expectWidenedOn(1, "mesura-chat-cursor");

    await openThread(addGlyphThread("back-to"));
    expect(widenedCursor(), "a thread opened for the first time paints nothing").toBeNull();
    expect(paintedGlyph("mesura-chat-cursor")).toBeNull();

    await act(async () => router!.history.back());
    await settle();
    expect(document.querySelector('[data-timeline-row-id*="back-from"]')).not.toBeNull();
    expectWidenedOn(1, "mesura-chat-cursor");
  });

  it("narrow glyph cursor fence regression: browser Back to a thread whose cursor sat on a wide glyph paints the highlight there", async () => {
    await chatCursorOnGlyphLine("back-wide-from");
    await press(key("l"));
    await press(DOLLAR);
    expectHighlightOnly("0", "mesura-chat-cursor");

    await openThread(addGlyphThread("back-wide-to"));
    await act(async () => router!.history.back());
    await settle();
    expectHighlightOnly("0", "mesura-chat-cursor");
  });
});

describe("narrow glyph cursor fence: the composer", () => {
  it("narrow glyph cursor fence spec: the composer cursor on i, l and . is a half-em overlay centred on the glyph", async () => {
    await composerCursorOnGlyphLine("composer-narrow");
    for (const glyph of NARROW_GLYPHS) {
      await press(key("l"));
      expectWidenedOn(GLYPH_LINE.indexOf(glyph), "mesura-composer-cursor");
    }
  });

  it("narrow glyph cursor fence spec: the widened composer cursor draws its glyph in var(--background) and the glyph's own font", async () => {
    await composerCursorOnGlyphLine("composer-font");
    await press(key("l"));
    const overlay = widenedCursor();
    expect(overlay, "the cursor on i is the widened overlay").not.toBeNull();
    expectGlyphDrawnInItsOwnFont(overlay!);
  });

  it("narrow glyph cursor fence spec: the widened composer cursor has the highlight cursor's colour in light and dark", async () => {
    await composerCursorOnGlyphLine("composer-colour");
    await press(key("l"));
    const overlay = widenedCursor();
    expect(overlay, "the cursor on i is the widened overlay").not.toBeNull();
    for (const theme of ["light", "dark"] as const) {
      expect(overlayBackground(overlay!, theme), `the ${theme} theme`).toBe(
        highlightBackground("mesura-composer-cursor", theme),
      );
    }
  });

  it("narrow glyph cursor fence spec: the widened composer cursor follows a scroll of the editor in the same frame", async () => {
    await composerCursorOnGlyphLine("composer-scroll");
    await press(key("l"));
    expectWidenedOn(1, "mesura-composer-cursor");

    fixture.glyphTop = 150;
    await withinTheSameFrame(() => composer().dispatchEvent(new Event("scroll")));
    expect(widenedCursor(), "the cursor stays widened after the scroll").not.toBeNull();
    expect(overlayBox(widenedCursor()!).top, "the overlay moved with the glyph").toBeCloseTo(
      150,
      6,
    );
    expectWidenedOn(1, "mesura-composer-cursor");
  });

  it("narrow glyph cursor fence spec: a held l moves the widened composer cursor glyph by glyph in the same frame", async () => {
    await composerCursorOnGlyphLine("composer-held");
    await press(key("l"));
    expectWidenedOn(1, "mesura-composer-cursor");
    await holdL();
    expectWidenedOn(2, "mesura-composer-cursor");
    await holdL();
    expectWidenedOn(3, "mesura-composer-cursor");
  });

  // Already true at the base, and must stay so: a guard.
  it("narrow glyph cursor fence guard: the composer cursor on a glyph half an em or wider is the highlight alone", async () => {
    await composerCursorOnGlyphLine("composer-wide");
    expectHighlightOnly("W", "mesura-composer-cursor");
    await press(DOLLAR);
    expectHighlightOnly("0", "mesura-composer-cursor");
  });

  // Already true at the base, and must stay so: a guard. Q2 of the plan: the
  // empty-line overlay keeps its own look even where it differs from the
  // highlight's colour.
  it("narrow glyph cursor fence guard: the composer's empty-line cursor is the overlay it was, with no glyph", async () => {
    await composerNormalWith("composer-empty", `${GLYPH_LINE}\n\nThe last line.`);
    // The first line, then the empty line under it.
    await press(key("g"));
    await press(key("g"));
    expect(paintedGlyph("mesura-composer-cursor"), "`gg` reaches the first line").toBe("W");
    await press(key("j"));
    expect(paintedGlyph("mesura-composer-cursor")).toBeNull();
    const overlays = blockCursorOverlays();
    expect(overlays, "one overlay draws the empty-line cursor").toHaveLength(1);
    const [overlay] = overlays;
    expect(overlay!.getAttribute("data-mesura-block-cursor")).not.toBe("glyph");
    expect(overlay!.classList.contains("w-[0.6em]"), "its width class").toBe(true);
    expect(overlay!.classList.contains("bg-sky-500/80"), "its colour class").toBe(true);
    expect(overlay!.textContent).toBe("");
  });
});
