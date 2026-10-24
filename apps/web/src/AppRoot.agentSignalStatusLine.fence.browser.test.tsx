import { act, render as renderBrowser, type Screen } from "../test/render";
/**
 * Entry point: AppRoot, with a memory router rendering the real ChatView, whose
 * `useThreadLifecycle` picks the chat status line above the composer. The
 * fixture replaces environment reads and RPC commands: every `useAtomCommand`
 * call records the command and its input, so a click proves which orchestration
 * command the application dispatched. Phone width is Playwright's Pixel 7
 * viewport (412 × 915).
 */

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ThreadAgentSignal,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { makeFenceThreadProjection, makeFenceThreadShell } from "./test/fenceThreadShell";
import {
  appRootFence,
  FENCE_ENVIRONMENT_ID,
  FENCE_PROJECT_ID,
  installFenceFontEvents,
} from "./test/appRootFenceMocks";
import { publishFenceThreadProjection } from "./test/appRootFenceApp";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  dispatched: [] as Array<{ command: unknown; value: unknown }>,
  settleThread: vi.fn(async (_target: unknown) => ({ _tag: "Success", value: undefined })),
  acknowledgeWoke: vi.fn(async (_target: unknown, _wokeAt: unknown) => ({
    _tag: "Success",
    value: undefined,
  })),
}));

const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (value: unknown) => {
    fixture.dispatched.push({ command, value });
    return { _tag: "Success", value: { providers: [] } };
  },
}));
vi.mock("./state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: { providers: [] } }),
}));
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", async () => ({
  ...(await (await fenceMocks()).mockHandleNewThread()),
  useNewThreadHandler: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("./hooks/useThreadActions", () => ({
  useAcknowledgeThreadWoke: () => fixture.acknowledgeWoke,
  useThreadActions: () => ({
    settleThread: fixture.settleThread,
    pinThread: async () => ({ _tag: "Success", value: undefined }),
    confirmAndUnpinThread: async () => ({ _tag: "Success", value: undefined }),
  }),
}));
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());

import { threadEnvironment } from "./state/threads";

const { AppRoot } = await import("./AppRoot");
const { default: ChatView } = await import("./components/ChatView");
const { SidebarProvider } = await import("./components/ui/sidebar");

const environmentId = EnvironmentId.make(FENCE_ENVIRONMENT_ID);
const threadId = ThreadId.make("agent-signal-status-line-thread");
const now = "2026-10-24T12:00:00.000Z";
const PIXEL_7 = { width: 412, height: 915 };
let root: Screen | undefined;
let container: HTMLDivElement;

const signalOf = (kind: ThreadAgentSignal["kind"], note: string | null): ThreadAgentSignal => ({
  kind,
  note,
  runId: RunId.make("agent-signal-status-line-run"),
  setAt: now,
});

async function setupStatusLineFixture(
  signal: ThreadAgentSignal | null,
  overrides: Partial<OrchestrationV2ThreadProjection["thread"]> = {},
  viewport = PIXEL_7,
) {
  fixture.dispatched.length = 0;
  fixture.settleThread.mockClear();
  fixture.acknowledgeWoke.mockClear();
  installFenceFontEvents();
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(viewport.width, viewport.height);
  // The shared fence declares only settlement and pinning; this fence adds snooze for the Woke guard.
  const capabilities: Record<string, unknown> =
    appRootFence.environments[0]!.serverConfig.environment.capabilities;
  const previousThreadSnooze = capabilities.threadSnooze;
  Object.assign(capabilities, { threadSnooze: true });
  const shell = makeFenceThreadShell({
    id: threadId,
    environmentId,
    projectId: ProjectId.make(FENCE_PROJECT_ID),
    title: "Agent signal fence",
    createdAt: now,
    overrides: { agentSignal: signal, ...overrides },
  });
  fixture.projection = makeFenceThreadProjection(shell);
  container = document.createElement("div");
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      container.remove();
      appRootFence.threads.clear();
      appRootFence.threadStates.clear();
      Object.assign(capabilities, { threadSnooze: previousThreadSnooze });
      await page.viewport(previousViewport.width, previousViewport.height);
      vi.unstubAllGlobals();
    },
  };
}

async function mountApp() {
  publishFenceThreadProjection(fixture.projection!, environmentId);
  const route = createRootRoute({
    component: () => (
      <SidebarProvider>
        <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
      </SidebarProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => route, path: "/" });
  const router = createRouter({
    routeTree: route.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => {
    root = await renderBrowser(null, { container: container, router: false });
    await root.rerender(<AppRoot router={router as unknown as AppRouter} />);
  });
}

function statusLine() {
  const line = container.querySelector<HTMLElement>('[data-chat-thread-status-line="true"]');
  expect(line, `Expected a chat status line; rendered: ${container.textContent}`).not.toBeNull();
  return line!;
}

function statusLineButton(line: HTMLElement, text: string) {
  const match = [...line.querySelectorAll("button")].find((entry) =>
    entry.textContent?.trim().startsWith(text),
  );
  expect(match, `Expected button ${text}; status line: ${line.textContent}`).toBeDefined();
  return match!;
}

// A touch target smaller than 24 CSS px fails WCAG 2.2's target-size minimum (2.5.8).
function expectTouchTarget(button: HTMLElement) {
  const box = button.getBoundingClientRect();
  expect(box.height, "touch target height").toBeGreaterThanOrEqual(24);
  expect(box.width, "touch target width").toBeGreaterThanOrEqual(24);
  expect(box.right, "inside the phone viewport").toBeLessThanOrEqual(PIXEL_7.width);
  expect(box.left).toBeGreaterThanOrEqual(0);
}

const clearDispatches = () =>
  fixture.dispatched.filter(
    (entry) =>
      entry.command !== undefined &&
      entry.command === (threadEnvironment as Record<string, unknown>).clearAgentSignal,
  );

it("AppRoot agent signal AC6: a needs_input signal shows its note and a touch-sized Dismiss that clears it", async () => {
  await using _fixture = await setupStatusLineFixture(
    signalOf("needs_input", "Which database should the migration target?"),
  );
  await mountApp();
  const line = statusLine();
  expect(line.textContent).toContain("Agent needs your input");
  expect(line.textContent).toContain("Which database should the migration target?");
  const dismiss = statusLineButton(line, "Dismiss");
  expectTouchTarget(dismiss);
  await userEvent.click(dismiss);
  expect(clearDispatches()).toEqual([
    {
      command: (threadEnvironment as Record<string, unknown>).clearAgentSignal,
      value: { environmentId, input: { threadId } },
    },
  ]);
});

it("AppRoot agent signal AC6: a ready_to_close signal offers Settle through the settle action and Dismiss", async () => {
  await using _fixture = await setupStatusLineFixture(signalOf("ready_to_close", null));
  await mountApp();
  const line = statusLine();
  expect(line.textContent).toContain("Agent says this thread is ready to close");
  const settle = statusLineButton(line, "Settle");
  const dismiss = statusLineButton(line, "Dismiss");
  expectTouchTarget(settle);
  expectTouchTarget(dismiss);
  await userEvent.click(settle);
  expect(fixture.settleThread).toHaveBeenCalledExactlyOnceWith(
    scopeThreadRef(environmentId, threadId),
  );
  await userEvent.click(dismiss);
  expect(clearDispatches()).toHaveLength(1);
});

it("AppRoot agent signal guard: a thread without a signal shows no chat status line", async () => {
  await using _fixture = await setupStatusLineFixture(null);
  await mountApp();
  expect(container.textContent).toContain("Send a message to start the conversation");
  expect(container.querySelector('[data-chat-thread-status-line="true"]')).toBeNull();
});

it("AppRoot agent signal guard: a thread woken from snooze keeps its Woke line and Dismiss", async () => {
  const snoozedUntil = "2026-01-02T09:00:00.000Z";
  await using _fixture = await setupStatusLineFixture(null, {
    snoozedAt: DateTime.makeUnsafe("2026-01-01T09:00:00.000Z"),
    snoozedUntil: DateTime.makeUnsafe(snoozedUntil),
    lastVisitedAt: null,
  });
  await mountApp();
  const line = statusLine();
  expect(line.textContent).toContain("Woke from snooze");
  await userEvent.click(statusLineButton(line, "Dismiss"));
  expect(fixture.acknowledgeWoke).toHaveBeenCalledExactlyOnceWith(
    scopeThreadRef(environmentId, threadId),
    snoozedUntil,
  );
  expect(clearDispatches()).toEqual([]);
});
