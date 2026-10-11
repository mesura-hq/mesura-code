// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout, as `routes/__root.tsx`
 * does, and whose chat layout is the real `_chat.tsx` route component (the
 * real KeyEngineHost around the real ChatView). ChatView's right panel, its
 * launcher (`RightPanelTabs.tsx`) and every surface it renders stay real. The
 * key engine is installed on `window` before React renders, as `main.tsx`
 * does. Keys are real `keydown` events dispatched from the focused element; a
 * tap is a `pointerdown` then a `click` on the tapped element.
 *
 * Phase 4 of the Vim keys round 2 cycle (land the keyboard in every panel
 * surface):
 * - Criterion 1: `Space p a` leaves focus inside the Agents surface's
 *   content, with and without live agents, never in the composer and never
 *   on the tab title.
 * - Criterion 2: `Space p l` and `Space p p` leave focus inside the pull
 *   request list's and the pull request's content.
 * - Criterion 3: `Space p s` leaves focus inside Software Factory's scrolling
 *   content.
 * - Criterion 4: a Markdown file shown rendered, and an image, take focus in
 *   their scroll region when `Ctrl+Tab` brings their tab back, and `Ctrl+D`
 *   there scrolls half a page.
 *   Leaving the Files tree (`Escape`, `Ctrl+E`) after Enter opened such a file
 *   lands in the same scroll region, as it lands in the editor for a source
 *   file (guard).
 * - Criterion 5: in `components/preview/PreviewPanel.launcher.test.tsx`; the
 *   native view exists only in the Electron window.
 * - Criterion 6, guard: `Space p m` (Device) leaves focus on the tab title.
 *   The Browser surface is desktop-only (`isPreviewSupportedInRuntime`), so
 *   its guard is in `PreviewPanel.launcher.test.tsx`.
 * - Criterion 7, guard: at a phone's width, a tap on the panel's `+` shows the
 *   full-panel launcher, a tapped row opens its surface, and no text entry
 *   holds focus. The verifier covers the real phone.
 *
 * happy-dom lays nothing out and loads no CSS. Every element reports one
 * client rect, so all of them count as shown, and the Tailwind overflow
 * utilities the surfaces scroll with (`overflow-y-auto`, `overflow-auto`)
 * read as `overflow-y: auto` through a stubbed computed style; base-ui's
 * ScrollArea viewport sets its overflow inline and needs no stub.
 *
 * Fixture state beyond `test/appRootFenceMocks.tsx`, each the least that makes
 * a surface render:
 * - The environment advertises `pullRequests` and `threadPullRequests`, and
 *   `useServerConfigs` reads it with the default server settings (the pull
 *   request page resolves project settings from it).
 * - The thread links one pull request and has it as its linked pull request,
 *   and the pull request's detail read answers with that pull request.
 * - The thread's activities hold a presented Software Factory plan and, where
 *   a spec asks for live agents, one running subagent.
 * - The device host finished onboarding (`useDeviceState`).
 * - The project's listing (`useProjectEntriesQuery`) holds three files, so the
 *   Files tree has rows to open.
 * - The file read (`useProjectFileQuery`) answers every text file with one
 *   Markdown document, and the asset URL (`useAssetUrlState`) answers every
 *   image with a URL. Rendered Markdown is the stored preference.
 * - An attachment's signed URL (`useAssetUrlRefresh`) resolves, and `fetch`
 *   answers it with one Markdown document.
 * - Tailwind's `invisible` reads as `visibility: hidden` on the element and
 *   everything under it, as the pull request page's inactive tabs are.
 */
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatFileAttachment, OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeFactoryPlanActivity } from "@t3tools/client-runtime/factory/testing";

// The boundaries the fixture replaces: see `test/appRootFenceMocks.tsx`, plus
// the server configs, the file read, the device state and the asset URL named
// above, and the diff highlighting worker pool.
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/entities", async (original) => {
  const mocks = await fenceMocks();
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const [environment] = mocks.appRootFence.environments;
  const configs = new Map([
    [
      environment!.environmentId,
      { ...environment!.serverConfig, settings: DEFAULT_SERVER_SETTINGS },
    ],
  ]);
  return { ...(await mocks.mockEntities(original)), useServerConfigs: () => configs };
});
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
/**
 * The pull request's detail read answers with one open pull request, and its
 * diff read with a one-file patch; every other query is empty, as in the
 * shared fixture. Each is told apart by the atoms `pullRequestEnvironment`'s
 * `detail` and `diff` built, recorded here.
 */
const pullRequestDetail = vi.hoisted(() => ({
  detailQueries: new WeakSet<object>(),
  diffQueries: new WeakSet<object>(),
  diff: {
    patch: [
      "diff --git a/build.ts b/build.ts",
      "index 1111111..2222222 100644",
      "--- a/build.ts",
      "+++ b/build.ts",
      "@@ -1,2 +1,3 @@",
      " export const steps = 3;",
      "+export const fixed = true;",
      " export default steps;",
      "",
    ].join("\n"),
    truncated: false,
    nextCursor: null,
  },
  view: {
    provider: "github",
    projectId: "app-root-fence-project",
    projectTitle: "App root fence",
    workspaceRoot: "/tmp/app-root-fence",
    repository: "acme/app",
    number: 7,
    title: "Fix the build",
    body: "The build runs in three steps.",
    url: "https://github.com/acme/app/pull/7",
    author: { login: "author", name: null, avatarUrl: null },
    viewer: "author",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headBranch: "fix-build",
    baseBranch: "main",
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
    reviewThreads: [],
    commits: [],
    mergeCapabilities: { merge: false, squash: false, rebase: false },
    capabilities: {
      diff: true,
      comment: false,
      search: true,
      actions: [],
      mergeMethods: [],
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
      edit: { changeRequest: false, comment: false },
    },
    viewerPermissions: {
      actions: [],
      comment: false,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    },
  },
}));
vi.mock("./state/query", async () => {
  const { useEnvironmentQuery } = (await fenceMocks()).mockQuery();
  return {
    useEnvironmentQuery: (query: unknown) => {
      const data = !(query instanceof Object)
        ? null
        : pullRequestDetail.detailQueries.has(query)
          ? pullRequestDetail.view
          : pullRequestDetail.diffQueries.has(query)
            ? pullRequestDetail.diff
            : null;
      return data === null
        ? useEnvironmentQuery()
        : { data, error: null, isPending: false, isSuccess: true, refresh: () => undefined };
    },
  };
});
vi.mock("./state/pullRequests", async (original) => {
  const actual = await original<typeof import("./state/pullRequests")>();
  return {
    ...actual,
    pullRequestEnvironment: new Proxy(actual.pullRequestEnvironment, {
      get: (target, property) => {
        const queries =
          property === "detail"
            ? pullRequestDetail.detailQueries
            : property === "diff"
              ? pullRequestDetail.diffQueries
              : null;
        if (queries === null) return Reflect.get(target, property, target);
        // The real atom, recorded: a refresh still mounts it.
        return (...args: Parameters<typeof target.detail>) => {
          const query = (Reflect.get(target, property, target) as typeof target.detail)(...args);
          queries.add(query);
          return query;
        };
      },
    }),
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
vi.mock("./components/files/mesuraFileManager/MesuraFileManagerLayer", async () =>
  (await fenceMocks()).mockFileManagerLayer(),
);
vi.mock("./keys/highlights", async () => (await fenceMocks()).mockHighlights());
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());
vi.mock("./components/files/projectFilesQueryState", async (original) => ({
  ...(await original<typeof import("./components/files/projectFilesQueryState")>()),
  // The project's listing: what the Files tree shows.
  useProjectEntriesQuery: () => ({
    data: {
      entries: [
        { path: "diagram.png", kind: "file" },
        { path: "guide.md", kind: "file" },
        { path: "index.ts", kind: "file" },
      ],
      truncated: false,
    },
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
  useProjectFileQuery: (
    _environmentId: string,
    _cwd: string,
    relativePath: string | null,
    enabled = true,
  ) => ({
    data:
      relativePath !== null && enabled
        ? { relativePath, contents: MARKDOWN_DOCUMENT, byteLength: 64, truncated: false }
        : null,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));
// A device host that finished onboarding, so the Device row opens its surface
// rather than the setup dialog.
vi.mock("./state/device", async (original) => ({
  ...(await original<typeof import("./state/device")>()),
  useDeviceState: () => ({
    state: {
      hosts: [],
      hostStatus: "ready",
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: true,
      agentAccessEnabled: false,
      hubBasePath: "/api/device-hub",
      revision: 1,
    },
    loaded: true,
  }),
}));
// happy-dom has no module workers: the highlighting pool is left out, as in
// `AppRoot.treeDiff.fence.test.tsx`, or Pierre's worker script runs on the
// page and logs every window message it does not recognise.
vi.mock("./components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
const signAttachmentUrl = vi.hoisted(() => async () => "http://fence.invalid/attachment");
vi.mock("./assets/assetUrls", async (original) => ({
  ...(await original<typeof import("./assets/assetUrls")>()),
  useAssetUrlState: () => ({ _tag: "Success", url: "http://fence.invalid/diagram.png" }),
  // An attachment preview signs its URL on open, through a stable function:
  // its effect re-signs whenever the function changes.
  useAssetUrlRefresh: () => signAttachmentUrl,
}));

import { useFileTreeStore } from "./components/files/mesuraTree/fileTreeStore";
import { installKeyEngine } from "./keys/keyEngine";
import { isFileTreeFocused } from "./lib/focusTargets";
import { ACTIVE_TAB_TITLE_SELECTOR } from "./lib/panelSurfaceFocus";
import { useRightPanelStore } from "./rightPanelStore";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
} from "./test/appRootFenceApp";
import { appRootFence as fixture, FENCE_PROJECT_ID } from "./test/appRootFenceMocks";

const MARKDOWN_DOCUMENT = "# Guide\n\nThe build runs in three steps.\n";
const ATTACHMENT_MARKDOWN = "# Notes\n\nThe release ships on Friday.\n";
const SURFACE_CONTENT_SELECTOR = "[data-right-panel-surface-content]";
const LAUNCHER_SELECTOR = '[aria-label="Open a surface"]';
const PULL_REQUEST_URL = "https://github.com/acme/app/pull/7";
const at = (second: number) => `2026-10-08T12:00:${String(second).padStart(2, "0")}.000Z`;

let root: Root | undefined;
let container: HTMLDivElement;
let threadSequence = 0;
const openedThreads: ThreadId[] = [];

// ChatView lazy-loads the file, Factory and Device panels, and the pull
// request page its Code tab; load them before any spec
// waits on them, under a hook timeout sized for a cold compile.
beforeAll(async () => {
  installKeyEngine();
  await Promise.all([
    import("./components/files/FilePreviewPanel"),
    import("./factory/FactoryPane"),
    import("./components/device/DevicePanel"),
    import("./components/pullRequest/PullRequestCodeTab"),
  ]);
}, 120_000);

beforeEach(() => {
  // Every timer and animation frame runs on test time: `settle` moves it.
  vi.useFakeTimers();
  // An attachment's text: what a Markdown attachment preview reads.
  vi.stubGlobal("fetch", async () => new Response(ATTACHMENT_MARKDOWN));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A browser's ClipboardItem owns the promises it is given. Monaco hands it one
  // on every click and cancels it on the next; happy-dom's leaves it unhandled.
  vi.stubGlobal(
    "ClipboardItem",
    class {
      readonly types: ReadonlyArray<string>;
      constructor(items: Record<string, Promise<unknown>>) {
        this.types = Object.keys(items);
        for (const item of Object.values(items)) Promise.resolve(item).catch(() => {});
      }
    },
  );
  // happy-dom has no canvas. Monaco's overview ruler paints on one each
  // frame; it gets a 2D context that draws nothing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      new Proxy(
        {},
        {
          get: (_target, property) =>
            property === "measureText" ? () => ({ width: 0 }) : () => undefined,
          set: () => true,
        },
      ) as unknown as RenderingContext,
  );
  const capabilities = fixture.environments[0]!.serverConfig.environment.capabilities as Record<
    string,
    boolean
  >;
  capabilities.pullRequests = true;
  capabilities.threadPullRequests = true;
  window.localStorage.setItem("t3code.renderMarkdown", "true");
  // Leaving the tree for the editor hides it; each spec starts with it shown.
  useFileTreeStore.setState({ explorerOpen: true });
  container = document.createElement("div");
  document.body.append(container);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => ({ length: 1 }) as DOMRectList,
  );
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computedStyle(element, pseudo);
    return withStubbedStyle(style, {
      overflowY: scrollsByClass(element) ? "auto" : null,
      // Tailwind's `invisible`, inherited as `visibility` is: the pull
      // request's tabs other than the shown one.
      visibility: element.closest(".invisible") !== null ? "hidden" : null,
    });
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  for (const threadId of openedThreads.splice(0)) {
    useRightPanelStore.getState().removeThread(scopeThreadRef(environmentId, threadId));
  }
  fixture.threads.clear();
  window.localStorage.clear();
  setViewport(DEFAULT_VIEWPORT);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** happy-dom's default window, and a Pixel 7's, where the panel lays out as the phone's sheet. */
const DEFAULT_VIEWPORT = { width: 1024, height: 768 };
const PIXEL_7_VIEWPORT = { width: 412, height: 915 };

function setViewport(size: { readonly width: number; readonly height: number }): void {
  (window as unknown as { happyDOM: { setViewport(size: object): void } }).happyDOM.setViewport(
    size,
  );
}

const OVERFLOW_UTILITIES = ["overflow-y-auto", "overflow-auto", "overflow-y-scroll"];

function scrollsByClass(element: Element): boolean {
  return OVERFLOW_UTILITIES.some((utility) => element.classList.contains(utility));
}

const CSS_NAMES = { overflowY: "overflow-y", visibility: "visibility" } as const;
type StubbedProperty = keyof typeof CSS_NAMES;

/** A computed style whose `overflow-y` and `visibility` read the given values, where not null. */
function withStubbedStyle(
  style: CSSStyleDeclaration,
  values: Readonly<Record<StubbedProperty, string | null>>,
): CSSStyleDeclaration {
  if (values.overflowY === null && values.visibility === null) return style;
  const byCssName = new Map<string, string | null>(
    (Object.keys(CSS_NAMES) as StubbedProperty[]).map((key) => [CSS_NAMES[key], values[key]]),
  );
  return new Proxy(style, {
    get(target, property) {
      if (property === "overflowY" || property === "visibility") {
        return values[property] ?? target[property];
      }
      if (property === "getPropertyValue") {
        return (name: string) => byCssName.get(name) ?? target.getPropertyValue(name);
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

/** A subagent the Agents surface lists as running. */
function runningAgentActivity(): OrchestrationThreadActivity {
  return {
    id: "fence-agent-started",
    tone: "info",
    kind: "task.started",
    summary: "task.started",
    payload: { taskId: "fence-agent", title: "Explore the build", agentKind: "agent" },
    turnId: null,
    createdAt: at(2),
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Registers a thread with one assistant reply, one linked pull request and a
 * presented Software Factory plan; `liveAgent` adds a running subagent.
 */
function addSurfaceThread({ liveAgent }: { readonly liveAgent: boolean }): ThreadId {
  threadSequence += 1;
  const id = `panel-entry-${threadSequence}`;
  const threadId = addFenceThread(id, "Panel entry fence", [
    makeMessage(`${id}-assistant`, "assistant", "The build is green."),
  ]);
  const thread = fixture.threads.get(threadId)! as unknown as Record<string, unknown>;
  thread.pullRequests = [
    {
      host: "github.com",
      repository: "acme/app",
      number: 7,
      url: PULL_REQUEST_URL,
      source: "manual",
      linkedAt: at(0),
      snapshot: null,
      stack: null,
    },
  ];
  thread.linkedPullRequest = {
    projectId: FENCE_PROJECT_ID,
    repository: "acme/app",
    number: 7,
    url: PULL_REQUEST_URL,
  };
  thread.activities = [
    makeFactoryPlanActivity({ createdAt: at(1) }),
    ...(liveAgent ? [runningAgentActivity()] : []),
  ];
  openedThreads.push(threadId);
  return threadId;
}

/** The thread's links go, as an unlink or a host sync takes the last one away. */
function unlinkEveryPullRequest(threadId: ThreadId): void {
  const thread = fixture.threads.get(threadId)!;
  fixture.threads.set(threadId, { ...thread, pullRequests: [] } as typeof thread);
  for (const listener of fixture.threadListeners) listener();
}

/** One display frame on the fake clock. */
const FRAME_MS = 16;
/**
 * Frames a key's effects take to land: the panel shows its new tab a frame or
 * more after the key, and `focusPanelSurfaceAfterRender` waits up to ten for
 * it. Far below `ENTRY_WAIT_MS`, so a surface that never renders its entry
 * leaves focus on its title instead of passing late.
 */
const SETTLE_FRAMES = 12;
/** Longer than any startup timer the app sets on mount. */
const APP_STARTUP_MS = 5_000;

/**
 * Runs `SETTLE_FRAMES` frames on the fake clock, with the React updates,
 * microtasks and mutation records each one brings.
 */
async function settle(): Promise<void> {
  for (let frame = 0; frame < SETTLE_FRAMES; frame += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
    });
  }
}

/** Mounts the app on `threadId` with Vim mode on, the chat holding the keyboard. */
async function mountApp(threadId: ThreadId): Promise<void> {
  ({ root } = await renderFenceApp(container, threadId, { vimMode: true }));
  // The app's startup timers run out before any step, as they would on a
  // real clock long before the first key.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(APP_STARTUP_MS);
  });
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
}

/** Dispatches one keydown from the focused element, as the browser does, and settles. */
async function press(chord: Chord): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await settle();
  return event;
}

/** `Space p` then `letter`: the launcher, then its row. */
async function openFromLauncher(letter: string): Promise<void> {
  await press({ key: " ", code: "Space" });
  await press({ key: "p", code: "KeyP" });
  expect(document.querySelector(LAUNCHER_SELECTOR), "Space p shows the launcher").not.toBeNull();
  await press({ key: letter, code: `Key${letter.toUpperCase()}` });
  expect(document.querySelector(LAUNCHER_SELECTOR), "the row closed the launcher").toBeNull();
}

function surfaceContent(): HTMLElement {
  const content = document.querySelector<HTMLElement>(SURFACE_CONTENT_SELECTOR);
  expect(content, "the panel shows a surface").not.toBeNull();
  return content!;
}

function isTextEntry(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName))
  );
}

/** Where focus is, for a readable failure. */
function describeFocus(): string {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return String(active);
  const label = active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40);
  return `<${active.tagName.toLowerCase()}> ${label ?? ""}`;
}

/** Focus is in the active surface's content, on no text entry and on no tab title. */
function expectFocusInSurfaceContent(): HTMLElement {
  const active = document.activeElement;
  expect(surfaceContent().contains(active), `focus is on ${describeFocus()}`).toBe(true);
  expect(isTextEntry(active), `focus is on ${describeFocus()}`).toBe(false);
  expect(active?.matches(ACTIVE_TAB_TITLE_SELECTOR) ?? false).toBe(false);
  return active as HTMLElement;
}

/** `Ctrl+D` on the focused scroll region scrolls it half a page down. */
async function expectHalfPageScroll(region: HTMLElement): Promise<void> {
  Object.defineProperty(region, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(region, "clientHeight", { configurable: true, value: 600 });
  const scrollBy = vi.fn();
  region.scrollBy = scrollBy as unknown as HTMLElement["scrollBy"];
  const event = await press({ key: "d", code: "KeyD", ctrlKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ top: 300 }));
}

describe("panel surface entry fence: a launcher letter lands in the surface", () => {
  it("panel entry fence spec: Space p a lands in the Agents list with a live agent", async () => {
    await mountApp(addSurfaceThread({ liveAgent: true }));
    await openFromLauncher("a");
    expect(surfaceContent().textContent).toContain("Explore the build");
    const active = expectFocusInSurfaceContent();
    expect(active.closest('[data-slot="composer-shell"]')).toBeNull();
  });

  it("panel entry fence spec: Space p a lands in the Agents surface with no agents yet", async () => {
    await mountApp(addSurfaceThread({ liveAgent: false }));
    await openFromLauncher("a");
    expect(surfaceContent().textContent).toContain("No agents yet");
    expectFocusInSurfaceContent();
  });

  it("panel entry fence spec: Space p l lands in the linked pull request list", async () => {
    await mountApp(addSurfaceThread({ liveAgent: false }));
    await openFromLauncher("l");
    expect(surfaceContent().querySelector(`a[href="${PULL_REQUEST_URL}"]`)).not.toBeNull();
    expectFocusInSurfaceContent();
  });

  it("panel entry fence spec: Space p p lands in the pull request's content", async () => {
    await mountApp(addSurfaceThread({ liveAgent: false }));
    await openFromLauncher("p");
    expect(surfaceContent().textContent).toContain("The build runs in three steps.");
    expectFocusInSurfaceContent();
  });

  it("panel entry fence spec: Space p s lands in Software Factory's scrolling content", async () => {
    await mountApp(addSurfaceThread({ liveAgent: false }));
    await openFromLauncher("s");
    const tabs = surfaceContent().querySelector('nav[aria-label="Factory tabs"]');
    expect(tabs, "the Factory surface shows").not.toBeNull();
    const scrollingBody = tabs!.nextElementSibling;
    expectFocusInSurfaceContent();
    expect(scrollingBody?.contains(document.activeElement), `focus is on ${describeFocus()}`).toBe(
      true,
    );
  });
});

describe("panel surface entry fence: returning to a pull request surface", () => {
  const nextTab = () => press({ key: "Tab", code: "Tab", ctrlKey: true });

  // The Code tab is the page's own state, so a remount (`Ctrl+Tab` away and
  // back) shows Summary again: the way back into Code is a pane move.
  it("panel entry fence spec: Ctrl+L back into a pull request on its Code tab lands in its diff", async () => {
    await mountApp(addSurfaceThread({ liveAgent: false }));
    await openFromLauncher("p");
    const codeTab = [
      ...surfaceContent().querySelectorAll<HTMLElement>('[aria-label="Pull request tabs"] button'),
    ].find((button) => button.textContent?.trim() === "Code");
    expect(codeTab, "the pull request shows its Code tab").toBeDefined();
    await act(async () => codeTab!.click());
    await settle();
    const summary = surfaceContent().querySelector("[data-pull-request-summary-scroll]");
    expect(summary?.closest(".invisible"), "Summary stays mounted, hidden").not.toBeNull();
    expect(surfaceContent().querySelector(".diff-render-surface"), "the diff shows").not.toBeNull();

    await press({ key: "h", code: "KeyH", ctrlKey: true });
    expect(surfaceContent().contains(document.activeElement), "Ctrl+H left the panel").toBe(false);
    await press({ key: "l", code: "KeyL", ctrlKey: true });
    const active = expectFocusInSurfaceContent();
    expect(active.classList.contains("diff-render-surface"), `focus is on ${describeFocus()}`).toBe(
      true,
    );
    await expectHalfPageScroll(active);
  });

  it("panel entry fence spec: Ctrl+Tab back to the pull request list lands in it after its last link goes", async () => {
    const threadId = addSurfaceThread({ liveAgent: false });
    await mountApp(threadId);
    await openFromLauncher("l");
    await openFromLauncher("a");
    // The last link goes while the keyboard is on Agents.
    await act(async () => unlinkEveryPullRequest(threadId));
    await settle();

    await nextTab();
    expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(
      "Pull requests",
    );
    expect(surfaceContent().textContent).toContain("No linked pull requests");
    expectFocusInSurfaceContent();
  });
});

describe("panel surface entry fence: a previewed file takes focus in its scroll region", () => {
  /**
   * Opens a surface with `open`, then moves the keyboard there the way the
   * developer does: `Space p a` puts it in the panel on Agents, and `Ctrl+Tab`
   * brings the surface's tab, titled `title`, back.
   */
  async function openThenCycleBack(
    open: (threadRef: ReturnType<typeof scopeThreadRef>) => void,
    title: string,
  ): Promise<void> {
    const threadId = addSurfaceThread({ liveAgent: false });
    await act(async () => open(scopeThreadRef(environmentId, threadId)));
    await mountApp(threadId);
    await openFromLauncher("a");
    await press({ key: "Tab", code: "Tab", ctrlKey: true });
    expect(
      document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent,
      "Ctrl+Tab brought the tab back",
    ).toContain(title);
  }

  async function openFileThenCycleBack(relativePath: string): Promise<void> {
    await openThenCycleBack(
      (threadRef) => useRightPanelStore.getState().openFile(threadRef, relativePath),
      relativePath.slice(relativePath.lastIndexOf("/") + 1),
    );
  }

  /** A file attached to a message, opened in the panel as the chat's attachment chips do. */
  async function openAttachmentThenCycleBack(name: string, mimeType: string): Promise<void> {
    await openThenCycleBack(
      (threadRef) =>
        useRightPanelStore.getState().openAttachment(threadRef, {
          type: "file",
          id: `attachment-${name}`,
          name,
          mimeType,
          sizeBytes: 64,
        } as ChatFileAttachment),
      name,
    );
  }

  it("panel entry fence spec: a rendered Markdown file takes focus in its scroll region", async () => {
    await openFileThenCycleBack("docs/guide.md");
    const heading = [...surfaceContent().querySelectorAll("h1")].find(
      (element) => element.textContent === "Guide",
    );
    expect(heading, "the Markdown file shows rendered").toBeDefined();
    const active = expectFocusInSurfaceContent();
    expect(active.contains(heading!), `focus is on ${describeFocus()}`).toBe(true);
    await expectHalfPageScroll(active);
  });

  it("panel entry fence spec: an image file takes focus in its scroll region", async () => {
    await openFileThenCycleBack("docs/diagram.png");
    const image = surfaceContent().querySelector('img[alt="docs/diagram.png"]');
    expect(image, "the image shows").not.toBeNull();
    const active = expectFocusInSurfaceContent();
    expect(active.contains(image), `focus is on ${describeFocus()}`).toBe(true);
    await expectHalfPageScroll(active);
  });

  it("panel entry fence spec: a rendered Markdown attachment takes focus in its scroll region", async () => {
    await openAttachmentThenCycleBack("notes.md", "text/markdown");
    const heading = [...surfaceContent().querySelectorAll("h1")].find(
      (element) => element.textContent === "Notes",
    );
    expect(heading, "the Markdown attachment shows rendered").toBeDefined();
    const active = expectFocusInSurfaceContent();
    expect(active.contains(heading!), `focus is on ${describeFocus()}`).toBe(true);
    await expectHalfPageScroll(active);
  });

  it("panel entry fence spec: an image attachment takes focus in its scroll region", async () => {
    await openAttachmentThenCycleBack("photo.png", "image/png");
    const image = surfaceContent().querySelector('img[alt="photo.png"]');
    expect(image, "the image attachment shows").not.toBeNull();
    const active = expectFocusInSurfaceContent();
    expect(active.contains(image), `focus is on ${describeFocus()}`).toBe(true);
    await expectHalfPageScroll(active);
  });
});

describe("panel surface entry fence: native surfaces keep their tab title", () => {
  it("panel entry fence guard: Space p m keeps focus on the Device tab title", async () => {
    await mountApp(addSurfaceThread({ liveAgent: false }));
    await openFromLauncher("m");
    const title = document.querySelector(ACTIVE_TAB_TITLE_SELECTOR);
    expect(title, "the Device tab is active").not.toBeNull();
    expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(title);
  });
});

describe("panel surface entry fence: the phone's +", () => {
  /** A tap: the pointer goes down on `element`, then the click lands. */
  async function tap(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
      );
      element.click();
    });
    await settle();
  }

  function launcherRow(label: string): HTMLButtonElement {
    const launcher = document.querySelector(LAUNCHER_SELECTOR);
    expect(launcher, "the launcher shows").not.toBeNull();
    const row = [...launcher!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.startsWith(label),
    );
    expect(row, `the launcher has a ${label} row`).toBeDefined();
    return row!;
  }

  it("panel entry fence guard: at a phone's width, tapping + then a row opens it with no text entry focused", async () => {
    setViewport(PIXEL_7_VIEWPORT);
    const threadId = addSurfaceThread({ liveAgent: true });
    await act(async () =>
      useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "agents"),
    );
    await mountApp(threadId);
    expect(
      document.querySelector('[data-preview-panel-mode="sheet"]'),
      "the panel is a sheet",
    ).not.toBeNull();
    const plus = document.querySelector<HTMLElement>('[aria-label="Add panel surface"]');
    expect(plus, "the panel shows its +").not.toBeNull();
    await tap(plus!);
    expect(isTextEntry(document.activeElement), `focus is on ${describeFocus()}`).toBe(false);

    for (const label of ["Software Factory", "Linked pull requests", "Agents"]) {
      await tap(launcherRow(label));
      expect(document.querySelector(LAUNCHER_SELECTOR), `${label} closed the launcher`).toBeNull();
      expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(
        label === "Linked pull requests" ? "Pull requests" : label,
      );
      expect(isTextEntry(document.activeElement), `focus is on ${describeFocus()}`).toBe(false);
      await tap(document.querySelector<HTMLElement>('[aria-label="Add panel surface"]')!);
    }
  });
});

describe("panel surface entry fence: leaving the Files tree lands in the open file", () => {
  /** The Files tree's rows under the project root, in the order it shows them. */
  const TREE_ROWS = ["diagram.png", "guide.md", "index.ts"];

  /**
   * Opens the Files surface with `Space p f`, which puts the keyboard in the
   * tree, then opens `name` with `j` and Enter, as the developer does. Enter
   * keeps the keyboard in the tree: leaving it is a separate key.
   */
  async function openFromTree(name: string): Promise<void> {
    await mountApp(addSurfaceThread({ liveAgent: false }));
    await openFromLauncher("f");
    expect(isFileTreeFocused(), `focus is on ${describeFocus()}`).toBe(true);
    // The tree keeps its cursor per project across mounts: start at the root.
    await press({ key: "Home", code: "Home" });
    for (let row = 0; row <= TREE_ROWS.indexOf(name); row += 1) {
      await press({ key: "j", code: "KeyJ" });
    }
    await press({ key: "Enter", code: "Enter" });
    expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(name);
    expect(isFileTreeFocused(), `focus is on ${describeFocus()}`).toBe(true);
  }

  const LEAVE_KEYS: ReadonlyArray<readonly [string, Chord]> = [
    ["Escape", { key: "Escape", code: "Escape" }],
    ["Ctrl+E", { key: "e", code: "KeyE", ctrlKey: true }],
  ];

  for (const [label, chord] of LEAVE_KEYS) {
    it(`panel entry fence spec: ${label} from the tree lands in a rendered Markdown file's scroll region`, async () => {
      await openFromTree("guide.md");
      await press(chord);
      const heading = [...surfaceContent().querySelectorAll("h1")].find(
        (element) => element.textContent === "Guide",
      );
      expect(heading, "the Markdown file shows rendered").toBeDefined();
      const active = expectFocusInSurfaceContent();
      expect(active.contains(heading!), `focus is on ${describeFocus()}`).toBe(true);
      expect(isFileTreeFocused()).toBe(false);
      await expectHalfPageScroll(active);
    });

    it(`panel entry fence spec: ${label} from the tree lands in an image's scroll region`, async () => {
      await openFromTree("diagram.png");
      await press(chord);
      const image = surfaceContent().querySelector('img[alt="diagram.png"]');
      expect(image, "the image shows").not.toBeNull();
      const active = expectFocusInSurfaceContent();
      expect(active.contains(image), `focus is on ${describeFocus()}`).toBe(true);
      await expectHalfPageScroll(active);
    });

    it(`panel entry fence guard: ${label} from the tree lands in the editor`, async () => {
      await openFromTree("index.ts");
      await press(chord);
      expect(
        document.activeElement?.closest("[data-monaco-file-surface]"),
        `focus is on ${describeFocus()}`,
      ).not.toBeNull();
    });
  }
});
