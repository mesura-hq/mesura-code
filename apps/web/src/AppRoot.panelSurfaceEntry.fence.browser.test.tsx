import { cdp, page } from "vite-plus/test/browser";
import { act, type Screen } from "../test/render";
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
 * - Criterion 1 was retired: upstream removed the Agents surface in v2.
 *   The launcher now guards its absence.
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
 * Chromium loads the app's CSS and owns layout, scrolling and animation
 * frames. The real LegendList preserves the list's pane entry and scroller.
 *
 * Fixture state beyond `test/appRootFenceMocks.tsx`, each the least that makes
 * a surface render:
 * - The environment advertises `pullRequests` and `threadPullRequests`, and
 *   `useServerConfigs` reads it with the default server settings (the pull
 *   request page resolves project settings from it).
 * - The thread links one pull request and has it as its linked pull request,
 *   and the pull request's detail read answers with that pull request.
 * - The thread's v2 turn items hold a presented Software Factory plan.
 * - The device host finished onboarding (`useDeviceState`).
 * - The project's listing (`useProjectEntriesQuery`) holds three files, so the
 *   Files tree has rows to open.
 * - The file read (`useProjectFileQuery`) answers every text file with one
 *   Markdown document, and the asset URL (`useAssetUrlState`) answers every
 *   image with a URL. Rendered Markdown is the stored preference.
 * - An attachment's signed URL (`useAssetUrlRefresh`) resolves to a data URL
 *   which Chromium loads as an image or fetches as a Markdown document.
 */
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ChatFileAttachment, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  makeFactoryCardTurnItem,
  makeFactoryPlanPayload,
} from "@t3tools/client-runtime/factory/testing";
import { makeFenceThreadShell } from "./test/fenceThreadShell";
import * as Option from "effect/Option";
import { ProjectId } from "@t3tools/contracts";

// The boundaries the fixture replaces: see `test/appRootFenceMocks.tsx`, plus
// the server configs, the file read, the device state and the asset URL named
// above, and the diff highlighting worker pool.
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);
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
      "@@ -1,2 +1,83 @@",
      " export const steps = 3;",
      "+export const fixed = true;",
      ...Array.from({ length: 80 }, (_, index) => `+export const buildStep${index} = ${index};`),
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
vi.mock("./state/query", async (original) => {
  const common = await (await fenceMocks()).mockQuery(original);
  const { useEnvironmentQuery } = common;
  return {
    ...common,
    useEnvironmentQuery: (query?: object | null) => {
      const data = !(query instanceof Object)
        ? null
        : pullRequestDetail.detailQueries.has(query)
          ? pullRequestDetail.view
          : pullRequestDetail.diffQueries.has(query)
            ? pullRequestDetail.diff
            : null;
      // Always call the fallback hook. A PR result can replace an empty result on the next render.
      // Skipping this subscription when data arrives changes React's hook order.
      const fallback = useEnvironmentQuery(query);
      return data === null
        ? fallback
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
// Diff worker startup is outside the panel keyboard behavior this fence owns.
vi.mock("./components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
const assetBoundary = vi.hoisted(() => {
  const imageUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="navy"/></svg>')}`;
  const markdownUrl = `data:text/markdown,${encodeURIComponent("# Notes\n\nThe release ships on Friday.\n")}`;
  return {
    imageUrl,
    refreshImage: async () => imageUrl,
    refreshMarkdown: async () => markdownUrl,
  };
});
vi.mock("./assets/assetUrls", async (original) => {
  const actual = await original<typeof import("./assets/assetUrls")>();
  return {
    ...actual,
    useAssetUrlState: () => ({ _tag: "Success", url: assetBoundary.imageUrl }),
    // Stable callbacks keep re-signing from restarting the attachment effect.
    useAssetUrlRefresh: (...[, resource]: Parameters<typeof actual.useAssetUrlRefresh>) =>
      resource?._tag === "attachment" && resource.mimeType?.startsWith("image/")
        ? assetBoundary.refreshImage
        : assetBoundary.refreshMarkdown,
  };
});

import { useFileTreeStore } from "./components/files/mesuraTree/fileTreeStore";
import { installKeyEngine } from "./keys/keyEngine";
import { composerEditorElement } from "./keys/focusScope";
import { isFileTreeFocused } from "./lib/focusTargets";
import { ACTIVE_TAB_TITLE_SELECTOR } from "./lib/panelSurfaceFocus";
import { useRightPanelStore } from "./rightPanelStore";
import { flushBrowserTasks } from "./test/browserTasks";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
  publishFenceThreadProjection,
} from "./test/appRootFenceApp";
import {
  appRootFence as fixture,
  FENCE_PROJECT_ID,
  makeFenceSession,
} from "./test/appRootFenceMocks";

const MARKDOWN_DOCUMENT = "# Guide\n\nThe build runs in three steps.\n";
const SURFACE_CONTENT_SELECTOR = "[data-right-panel-surface-content]";
const LAUNCHER_SELECTOR = '[aria-label="Open a surface"]';
const PULL_REQUEST_URL = "https://github.com/acme/app/pull/7";
const at = (second: number) => `2026-10-08T12:00:${String(second).padStart(2, "0")}.000Z`;

let root: Screen | undefined;
let container: HTMLDivElement;
let threadSequence = 0;
const openedThreads: ThreadId[] = [];

// ChatView lazy-loads the file, Factory and Device panels, and the pull
// request page its Code tab; load them before any spec
// waits on them, under a hook timeout sized for a cold compile.
async function setupBrowserFixture0() {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await setViewport(DESKTOP_VIEWPORT);
  await installKeyEngine();
  await Promise.all([
    import("./components/files/FilePreviewPanel"),
    import("./factory/FactoryPane"),
    import("./components/device/DevicePanel"),
    import("./components/pullRequest/PullRequestCodeTab"),
  ]);

  // The source-file guards exercise the editable Monaco surface, which requires a write grant.
  fixture.sessions.set(
    environmentId,
    makeFenceSession([
      "orchestration:read",
      "orchestration:operate",
      "filesystem:read",
      "filesystem:write",
    ]),
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
  container.style.cssText = "width: 100%; height: 100dvh;";
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      container.remove();
      for (const threadId of openedThreads.splice(0)) {
        useRightPanelStore.getState().removeThread(scopeThreadRef(environmentId, threadId));
      }
      fixture.threads.clear();
      fixture.threadStates.clear();
      window.localStorage.clear();
      await setViewport(previousViewport);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

/** The desktop panel and the phone sheet both use Chromium's viewport. */
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const PIXEL_7_VIEWPORT = { width: 412, height: 915 };

async function setViewport(size: {
  readonly width: number;
  readonly height: number;
}): Promise<void> {
  await page.viewport(size.width, size.height);
}

/** Registers v2 links and a Factory card at the same boundaries as the live client. */
function addSurfaceThread(): ThreadId {
  threadSequence += 1;
  const id = `panel-entry-${threadSequence}`;
  const threadId = addFenceThread(id, "Panel entry fence", [
    makeMessage(`${id}-assistant`, "assistant", "The build is green."),
  ]);
  const previous = fixture.threads.get(threadId)!;
  const shell = makeFenceThreadShell({
    id: threadId,
    environmentId,
    projectId: ProjectId.make(FENCE_PROJECT_ID),
    overrides: {
      ...previous.source,
      itemCount: previous.source.itemCount + 1,
      visibleItemCount: previous.source.visibleItemCount + 1,
      pullRequests: [
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
      ],
      linkedPullRequest: {
        projectId: ProjectId.make(FENCE_PROJECT_ID),
        repository: "acme/app",
        number: 7,
        url: PULL_REQUEST_URL,
      },
    },
  });
  const state = fixture.threadStates.get(threadId)!;
  const projection = Option.getOrThrow(state.data);
  const card = makeFactoryCardTurnItem({
    id: `${id}-plan`,
    threadId,
    createdAt: at(1),
    ordinal: projection.turnItems.length,
    card: { kind: "plan", payload: makeFactoryPlanPayload() },
  });
  publishFenceThreadProjection(
    {
      ...projection,
      thread: { ...shell.source, lastVisitedAt: shell.source.lastVisitedAt ?? null },
      turnItems: [...projection.turnItems, card],
      visibleTurnItems: [
        ...projection.visibleTurnItems,
        {
          item: card,
          position: projection.visibleTurnItems.length,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: card.id,
        },
      ],
    },
    environmentId,
  );
  openedThreads.push(threadId);
  return threadId;
}

/** An unlink updates both the shell and detail streams. */
function unlinkEveryPullRequest(threadId: ThreadId): void {
  const previous = fixture.threads.get(threadId)!;
  const shell = makeFenceThreadShell({
    id: threadId,
    environmentId,
    projectId: previous.projectId,
    overrides: { ...previous.source, pullRequests: [], linkedPullRequest: null },
  });
  const projection = Option.getOrThrow(fixture.threadStates.get(threadId)!.data);
  publishFenceThreadProjection(
    {
      ...projection,
      thread: { ...shell.source, lastVisitedAt: shell.source.lastVisitedAt ?? null },
    },
    environmentId,
  );
}

/** Mounts the app on `threadId` with Vim mode on, the chat holding the keyboard. */
async function mountApp(threadId: ThreadId): Promise<void> {
  ({ root } = await renderFenceApp(container, threadId, { vimMode: true }));
  await vi.waitFor(() => expect(document.documentElement.dataset.mesuraVimMode).toBe("on"));
  // The route focuses the composer on mount. Observe that focus before blur
  // so its startup frame cannot take the keyboard back from a new surface.
  await vi.waitFor(() => {
    expect(composerEditorElement()).not.toBeNull();
    const active = document.activeElement;
    expect(
      active === composerEditorElement() ||
        document.querySelector("[data-pane-entry]")?.contains(active),
    ).toBe(true);
  });
  // Native actionability settles the editor's layout and pending startup focus.
  if (window.innerWidth >= 640) await page.elementLocator(composerEditorElement()!).click();
  await act(async () => (document.activeElement as HTMLElement | null)?.blur());
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
}

/** Dispatches one keydown from the focused element; callers wait for its DOM or focus result. */
async function press(chord: Chord): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await flushBrowserTasks();
  return event;
}

/** `Space p` then `letter`: the launcher, then its row. */
async function openFromLauncher(letter: string): Promise<void> {
  await press({ key: " ", code: "Space" });
  await press({ key: "p", code: "KeyP" });
  await vi.waitFor(() =>
    expect(document.querySelector(LAUNCHER_SELECTOR), "Space p shows the launcher").not.toBeNull(),
  );
  await vi.waitFor(() =>
    expect(document.querySelector(LAUNCHER_SELECTOR)?.contains(document.activeElement)).toBe(true),
  );
  await press({ key: letter, code: `Key${letter.toUpperCase()}` });
  await vi.waitFor(() =>
    expect(document.querySelector(LAUNCHER_SELECTOR), "the row closed the launcher").toBeNull(),
  );
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
async function expectFocusInSurfaceContent(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const content = surfaceContent();
    const active = document.activeElement;
    expect(active, "the surface entry replaces the launcher's temporary focus").not.toBe(content);
    expect(content.contains(active), `focus is on ${describeFocus()}`).toBe(true);
    expect(isTextEntry(active), `focus is on ${describeFocus()}`).toBe(false);
    expect(active?.matches(ACTIVE_TAB_TITLE_SELECTOR) ?? false).toBe(false);
    return active as HTMLElement;
  });
}

async function surfaceHeading(text: string, message: string): Promise<HTMLHeadingElement> {
  return vi.waitFor(() => {
    const heading = [...surfaceContent().querySelectorAll("h1")].find(
      (element) => element.textContent === text,
    );
    expect(heading, message).toBeDefined();
    return heading!;
  });
}

async function surfaceImage(alt: string, message: string): Promise<HTMLImageElement> {
  return vi.waitFor(() => {
    const image = [...surfaceContent().querySelectorAll("img")].find(
      (element) => element.alt === alt,
    );
    expect(image ?? null, message).not.toBeNull();
    expect(image!.complete && image!.naturalWidth > 0, "Chromium decodes the preview image").toBe(
      true,
    );
    return image!;
  });
}

/** `Ctrl+D` on the focused scroll region scrolls it half a page down. */
async function expectHalfPageScroll(region: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(region.clientHeight).toBeGreaterThan(0));
  // Images fit their viewport and these documents are short. Add real content
  // there. The diff virtualizer only counts its own expanded file content.
  const overflow = region.classList.contains("diff-render-surface")
    ? null
    : document.createElement("div");
  if (overflow) {
    overflow.setAttribute("aria-hidden", "true");
    overflow.style.cssText = `height: ${region.clientHeight * 4}px; width: 1px; flex-shrink: 0;`;
    region.append(overflow);
  }
  const scrollBy = vi.spyOn(region, "scrollBy");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    // Chromium applies reduced motion so the native scroll has no animation to settle.
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await vi.waitFor(() =>
      expect(region.scrollHeight - region.clientHeight).toBeGreaterThan(region.clientHeight / 2),
    );
    region.scrollTop = 0;
    const halfPage = region.clientHeight / 2;
    const event = await press({ key: "d", code: "KeyD", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ top: halfPage }));
    await vi.waitFor(() => {
      if (region.classList.contains("diff-render-surface")) {
        // The PR header and virtualizer compensate scrollTop as the viewport changes.
        expect(region.scrollTop).toBeGreaterThan(0);
        expect(region.scrollTop).toBeLessThanOrEqual(region.scrollHeight - region.clientHeight);
      } else {
        expect(Math.abs(region.scrollTop - halfPage)).toBeLessThanOrEqual(1);
      }
    });
  } finally {
    scrollBy.mockRestore();
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: reduceMotion ? "reduce" : "no-preference" },
      ],
    });
    overflow?.remove();
  }
}

describe("panel surface entry fence: a launcher letter lands in the surface", () => {
  // Upstream removed the Agents surface in v2. The launcher must not offer its obsolete route.
  it("panel entry fence guard: the v2 launcher omits the removed Agents surface", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp(addSurfaceThread());
    await press({ key: " ", code: "Space" });
    await press({ key: "p", code: "KeyP" });
    await vi.waitFor(() => expect(document.querySelector(LAUNCHER_SELECTOR)).not.toBeNull());
    const launcher = document.querySelector(LAUNCHER_SELECTOR);
    expect(launcher).not.toBeNull();
    expect(
      [...launcher!.querySelectorAll("button")].some((button) =>
        button.textContent?.startsWith("Agents"),
      ),
    ).toBe(false);
  });

  it("panel entry fence spec: Space p l lands in the linked pull request list", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp(addSurfaceThread());
    await openFromLauncher("l");
    await expectFocusInSurfaceContent();
    expect(surfaceContent().querySelector(`a[href="${PULL_REQUEST_URL}"]`)).not.toBeNull();
  });

  it("panel entry fence spec: Space p p lands in the pull request's content", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp(addSurfaceThread());
    await openFromLauncher("p");
    await vi.waitFor(() =>
      expect(surfaceContent().textContent).toContain("The build runs in three steps."),
    );
    expect(surfaceContent().textContent).toContain("The build runs in three steps.");
    await expectFocusInSurfaceContent();
  });

  it("panel entry fence spec: Space p s lands in Software Factory's scrolling content", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp(addSurfaceThread());
    await openFromLauncher("s");
    await vi.waitFor(() =>
      expect(surfaceContent().querySelector('nav[aria-label="Factory tabs"]')).not.toBeNull(),
    );
    const tabs = surfaceContent().querySelector('nav[aria-label="Factory tabs"]');
    expect(tabs, "the Factory surface shows").not.toBeNull();
    const scrollingBody = tabs!.nextElementSibling;
    await expectFocusInSurfaceContent();
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
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp(addSurfaceThread());
    await openFromLauncher("p");
    await expectFocusInSurfaceContent();
    const codeTab = [
      ...surfaceContent().querySelectorAll<HTMLElement>('[aria-label="Pull request tabs"] button'),
    ].find((button) => button.textContent?.trim() === "Code");
    expect(codeTab, "the pull request shows its Code tab").toBeDefined();
    await page.elementLocator(codeTab!).click();
    await vi.waitFor(() =>
      expect(
        surfaceContent().querySelector(".diff-render-surface"),
        "the diff shows",
      ).not.toBeNull(),
    );
    const summary = surfaceContent().querySelector("[data-pull-request-summary-scroll]");
    expect(summary?.closest(".invisible"), "Summary stays mounted, hidden").not.toBeNull();
    expect(surfaceContent().querySelector(".diff-render-surface"), "the diff shows").not.toBeNull();
    // The default folds every file. Native half-page scrolling needs an expanded diff.
    await page
      .elementLocator(
        surfaceContent().querySelector<HTMLButtonElement>('[aria-label="Expand all files"]')!,
      )
      .click();
    await vi.waitFor(() => {
      const diff = surfaceContent().querySelector<HTMLElement>(".diff-render-surface")!;
      expect(diff.scrollHeight - diff.clientHeight).toBeGreaterThan(diff.clientHeight / 2);
    });

    await press({ key: "h", code: "KeyH", ctrlKey: true });
    await vi.waitFor(() =>
      expect(surfaceContent().contains(document.activeElement), "Ctrl+H left the panel").toBe(
        false,
      ),
    );
    await press({ key: "l", code: "KeyL", ctrlKey: true });
    const active = await expectFocusInSurfaceContent();
    expect(active.classList.contains("diff-render-surface"), `focus is on ${describeFocus()}`).toBe(
      true,
    );
    await expectHalfPageScroll(active);
  });

  it("panel entry fence spec: Ctrl+Tab back to the pull request list lands in it after its last link goes", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const threadId = addSurfaceThread();
    await mountApp(threadId);
    await openFromLauncher("l");
    await expectFocusInSurfaceContent();
    await openFromLauncher("s");
    await expectFocusInSurfaceContent();
    // The last link goes while the keyboard is on Software Factory.
    await act(async () => unlinkEveryPullRequest(threadId));
    await nextTab();
    await vi.waitFor(() =>
      expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(
        "Pull requests",
      ),
    );
    await vi.waitFor(() =>
      expect(surfaceContent().textContent).toContain("No linked pull requests"),
    );
    expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(
      "Pull requests",
    );
    expect(surfaceContent().textContent).toContain("No linked pull requests");
    await expectFocusInSurfaceContent();
  });
});

describe("panel surface entry fence: a previewed file takes focus in its scroll region", () => {
  /**
   * Opens a surface with `open`, then moves the keyboard there the way the
   * developer does: `Space p s` puts it in the panel on Software Factory, and `Ctrl+Tab`
   * brings the surface's tab, titled `title`, back.
   */
  async function openThenCycleBack(
    open: (threadRef: ReturnType<typeof scopeThreadRef>) => void,
    title: string,
    imageAlt = title,
  ): Promise<void> {
    const threadId = addSurfaceThread();
    await act(async () => open(scopeThreadRef(environmentId, threadId)));
    await mountApp(threadId);
    // Load the initial preview before testing a return to its existing surface.
    // Returning while a loading entry is replaced exercises a different lifecycle.
    if (title.endsWith(".md"))
      await surfaceHeading(
        title === "notes.md" ? "Notes" : "Guide",
        "the initial Markdown preview loads",
      );
    else if (title.endsWith(".png"))
      await surfaceImage(imageAlt, "the initial image preview loads");
    await openFromLauncher("s");
    await expectFocusInSurfaceContent();
    await press({ key: "Tab", code: "Tab", ctrlKey: true });
    await vi.waitFor(() =>
      expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(title),
    );
    expect(
      document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent,
      "Ctrl+Tab brought the tab back",
    ).toContain(title);
  }

  async function openFileThenCycleBack(relativePath: string): Promise<void> {
    await openThenCycleBack(
      (threadRef) => useRightPanelStore.getState().openFile(threadRef, relativePath),
      relativePath.slice(relativePath.lastIndexOf("/") + 1),
      relativePath,
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
    await using _browserFixture0 = await setupBrowserFixture0();

    await openFileThenCycleBack("docs/guide.md");
    const heading = await surfaceHeading("Guide", "the Markdown file shows rendered");
    expect(heading, "the Markdown file shows rendered").toBeDefined();
    const active = await expectFocusInSurfaceContent();
    expect(active.contains(heading!), `focus is on ${describeFocus()}`).toBe(true);
    await expectHalfPageScroll(active);
  });

  it("panel entry fence spec: an image file takes focus in its scroll region", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await openFileThenCycleBack("docs/diagram.png");
    const image = await surfaceImage("docs/diagram.png", "the image shows");
    expect(image, "the image shows").not.toBeNull();
    const active = await expectFocusInSurfaceContent();
    expect(active.contains(image), `focus is on ${describeFocus()}`).toBe(true);
    await expectHalfPageScroll(active);
  });

  it("panel entry fence spec: a rendered Markdown attachment takes focus in its scroll region", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await openAttachmentThenCycleBack("notes.md", "text/markdown");
    const heading = await surfaceHeading("Notes", "the Markdown attachment shows rendered");
    expect(heading, "the Markdown attachment shows rendered").toBeDefined();
    const active = await expectFocusInSurfaceContent();
    expect(active.contains(heading!), `focus is on ${describeFocus()}`).toBe(true);
    await expectHalfPageScroll(active);
  });

  it("panel entry fence spec: an image attachment takes focus in its scroll region", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await openAttachmentThenCycleBack("photo.png", "image/png");
    const image = await surfaceImage("photo.png", "the image attachment shows");
    expect(image, "the image attachment shows").not.toBeNull();
    const active = await expectFocusInSurfaceContent();
    expect(active.contains(image), `focus is on ${describeFocus()}`).toBe(true);
    await expectHalfPageScroll(active);
  });
});

describe("panel surface entry fence: native surfaces keep their tab title", () => {
  it("panel entry fence guard: Space p m keeps focus on the Device tab title", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp(addSurfaceThread());
    await openFromLauncher("m");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)),
    );
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
    await flushBrowserTasks();
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
    await using _browserFixture0 = await setupBrowserFixture0();

    await setViewport(PIXEL_7_VIEWPORT);
    const threadId = addSurfaceThread();
    await act(async () =>
      useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "factory"),
    );
    await mountApp(threadId);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-preview-panel-mode="sheet"]')).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-preview-panel-mode="sheet"]'),
      "the panel is a sheet",
    ).not.toBeNull();
    const plus = document.querySelector<HTMLElement>('[aria-label="Add panel surface"]');
    expect(plus, "the panel shows its +").not.toBeNull();
    await tap(plus!);
    await vi.waitFor(() => expect(document.querySelector(LAUNCHER_SELECTOR)).not.toBeNull());
    expect(isTextEntry(document.activeElement), `focus is on ${describeFocus()}`).toBe(false);

    for (const label of ["Software Factory", "Linked pull requests", "Files"]) {
      await tap(launcherRow(label));
      await vi.waitFor(() => {
        expect(
          document.querySelector(LAUNCHER_SELECTOR),
          `${label} closed the launcher`,
        ).toBeNull();
        expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(
          label === "Linked pull requests" ? "Pull requests" : label,
        );
      });
      expect(document.querySelector(LAUNCHER_SELECTOR), `${label} closed the launcher`).toBeNull();
      expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(
        label === "Linked pull requests" ? "Pull requests" : label,
      );
      expect(isTextEntry(document.activeElement), `focus is on ${describeFocus()}`).toBe(false);
      await tap(document.querySelector<HTMLElement>('[aria-label="Add panel surface"]')!);
      await vi.waitFor(() => expect(document.querySelector(LAUNCHER_SELECTOR)).not.toBeNull());
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
    await mountApp(addSurfaceThread());
    await openFromLauncher("f");
    await vi.waitFor(() =>
      expect(isFileTreeFocused(), `focus is on ${describeFocus()}`).toBe(true),
    );
    // The tree keeps its cursor per project across mounts: start at the root.
    await press({ key: "Home", code: "Home" });
    for (let row = 0; row <= TREE_ROWS.indexOf(name); row += 1) {
      await press({ key: "j", code: "KeyJ" });
    }
    await press({ key: "Enter", code: "Enter" });
    await vi.waitFor(() =>
      expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(name),
    );
    if (name.endsWith(".png")) await surfaceImage(name, "the image shows");
    else if (name.endsWith(".md"))
      await surfaceHeading("Guide", "the Markdown file shows rendered");
    else
      await vi.waitFor(() =>
        expect(
          surfaceContent().querySelector("[data-monaco-file-surface] textarea"),
        ).not.toBeNull(),
      );
    expect(document.querySelector(ACTIVE_TAB_TITLE_SELECTOR)?.textContent).toContain(name);
    expect(isFileTreeFocused(), `focus is on ${describeFocus()}`).toBe(true);
  }

  const LEAVE_KEYS: ReadonlyArray<readonly [string, Chord]> = [
    ["Escape", { key: "Escape", code: "Escape" }],
    ["Ctrl+E", { key: "e", code: "KeyE", ctrlKey: true }],
  ];

  it.each(LEAVE_KEYS)(
    "panel entry fence spec: %s from the tree lands in a rendered Markdown file's scroll region",
    async (_label, chord) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await openFromTree("guide.md");
      await press(chord);
      const heading = await surfaceHeading("Guide", "the Markdown file shows rendered");
      expect(heading, "the Markdown file shows rendered").toBeDefined();
      const active = await expectFocusInSurfaceContent();
      expect(active.contains(heading!), `focus is on ${describeFocus()}`).toBe(true);
      expect(isFileTreeFocused()).toBe(false);
      await expectHalfPageScroll(active);
    },
  );

  it.each(LEAVE_KEYS)(
    "panel entry fence spec: %s from the tree lands in an image's scroll region",
    async (_label, chord) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await openFromTree("diagram.png");
      await press(chord);
      const image = await surfaceImage("diagram.png", "the image shows");
      expect(image, "the image shows").not.toBeNull();
      const active = await expectFocusInSurfaceContent();
      expect(active.contains(image), `focus is on ${describeFocus()}`).toBe(true);
      await expectHalfPageScroll(active);
    },
  );

  it.each(LEAVE_KEYS)(
    "panel entry fence guard: %s from the tree lands in the editor",
    async (_label, chord) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await openFromTree("index.ts");
      await press(chord);
      await vi.waitFor(() =>
        expect(
          document.activeElement?.closest("[data-monaco-file-surface]"),
          `focus is on ${describeFocus()}`,
        ).not.toBeNull(),
      );
      expect(
        document.activeElement?.closest("[data-monaco-file-surface]"),
        `focus is on ${describeFocus()}`,
      ).not.toBeNull();
    },
  );
});
