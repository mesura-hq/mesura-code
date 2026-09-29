// @vitest-environment happy-dom
/**
 * Phase 8 fence on the web: acceptance criteria 1, 3 and 6, through the run
 * card a `factory.run` activity renders in the timeline.
 *
 * Entry point: AppRoot with its memory router and the real ChatView,
 * MessagesTimeline and FactoryRunCard, mounted as `FactoryPlanApproval.test.tsx`
 * mounts them. The thread and its activities are fixtures; a new activity with
 * the run's id replaces the old one, as the server's run tracker does. What
 * only a browser shows: the tones' colours, the phase marks' shapes, and the
 * card's layout on a narrow pane.
 */
/// <reference types="vite-plus/client" />
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  factoryRunActivityId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  makeFactoryRouteProviders,
  makeFactoryRunActivity,
  makeFactoryRunSummary,
  withoutFactoryRunMarks,
  type FactoryRunFixturePoint,
} from "@t3tools/client-runtime/factory/testing";
import type { Thread } from "../types";
import type { AppRouter } from "../router";

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  commands: new Map<unknown, unknown>(),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  refresh: vi.fn(),
  empty: [],
  threadListeners: new Set<() => void>(),
  factorySnapshots: {} as Record<string, string>,
  factorySnapshotAtoms: new Map<string, unknown>(),
  environments: [
    {
      environmentId: "factory-run-environment",
      label: "Factory run environment",
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          capabilities: {
            questionAttachments: true,
            attachmentUploads: true,
            fileAttachments: { maxUploadBytes: 1048576 },
          },
        },
        providers: [] as unknown[],
      },
    },
  ],
}));

vi.mock("../state/entities", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const useFixtureThread = () =>
    useSyncExternalStore(
      (listener) => {
        fixture.threadListeners.add(listener);
        return () => {
          fixture.threadListeners.delete(listener);
        };
      },
      () => fixture.thread,
    );
  return {
    ...(await importOriginal<typeof import("../state/entities")>()),
    useThread: useFixtureThread,
    readThread: () => fixture.thread,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => ({
      id: "factory-run-project",
      environmentId: "factory-run-environment",
      title: "Factory run",
      workspaceRoot: "/tmp/factory-run",
      scripts: [],
      createdAt: "2026-09-28T10:00:00.000Z",
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
    }),
  };
});
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments, isReady: true }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: fixture.refresh,
  }),
}));
vi.mock("../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => fixture.commands.get(command) ?? fixture.noopCommand,
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => fixture.noopCommand,
}));
// The plan body a `factory.plan` activity names by digest, as the server's
// factoryReadSnapshot RPC would answer it; an unknown digest stays loading.
vi.mock("../state/factory", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  return {
    factoryEnvironment: {
      factorySnapshot: ({ input }: { input: { digest: string } }) => {
        const markdown = fixture.factorySnapshots[input.digest];
        const key = `${input.digest}:${markdown === undefined ? "loading" : "ready"}`;
        let atom = fixture.factorySnapshotAtoms.get(key);
        if (atom === undefined) {
          atom = Atom.make(
            markdown === undefined
              ? AsyncResult.initial(true)
              : AsyncResult.success({ digest: input.digest, markdown }),
          );
          fixture.factorySnapshotAtoms.set(key, atom);
        }
        return atom;
      },
    },
  };
});
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  return {
    ...(await importOriginal<typeof import("../hooks/useSettings")>()),
    useEnvironmentSettings: () => settings,
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
  };
});
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => fixture.noopCommand }));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: fixture.noopCommand,
    pinThread: fixture.noopCommand,
    confirmAndUnpinThread: fixture.noopCommand,
  }),
}));
vi.mock("../components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("../browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("../components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("../components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../components/BranchToolbar", () => ({ BranchToolbar: () => null }));

// happy-dom has no layout. Keep application routing and timeline projection
// real, and replace only the virtual list's measurement boundary.
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
    <div>
      {ListHeaderComponent}
      {data.map((item) => (
        <div data-timeline-row={item.id} key={item.id}>
          {renderItem({ item })}
        </div>
      ))}
      {ListFooterComponent}
    </div>
  ),
}));

import { AppRoot } from "../AppRoot";
import ChatView from "../components/ChatView";
import { SidebarProvider } from "../components/ui/sidebar";
import { useComposerDraftStore } from "../composerDraftStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import eventsJsonl from "../../../../packages/shared/src/fixtures/factory-events.v1.jsonl?raw";

const environmentId = EnvironmentId.make("factory-run-environment");
const threadId = ThreadId.make("factory-run-card-thread");
const runRowId = factoryRunActivityId(threadId, "invoice-csv-export");
const REQUEST = "Let accountants export the invoice list as a CSV file";
let root: Root | undefined;
let container: HTMLDivElement;

const runActivity = (point: FactoryRunFixturePoint) =>
  makeFactoryRunActivity({ threadId, summary: makeFactoryRunSummary(eventsJsonl, point) });

/** Delivers a new thread object, as the thread store does on every event. */
async function showRunAt(point: FactoryRunFixturePoint) {
  fixture.thread = {
    ...fixture.thread!,
    activities: [
      ...fixture.thread!.activities.filter((activity) => activity.id !== runRowId),
      runActivity(point),
    ],
  };
  await act(async () => {
    for (const listener of fixture.threadListeners) listener();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.factorySnapshots = {};
  fixture.factorySnapshotAtoms.clear();
  const [environment] = fixture.environments;
  fixture.environments = [
    {
      ...environment!,
      serverConfig: {
        ...environment!.serverConfig,
        providers: makeFactoryRouteProviders().map((provider) => ({
          ...provider,
          workspaceSnapshots: [
            {
              cwd: "/tmp/factory-run",
              checkedAt: "2026-09-28T08:58:00.000Z",
              skills: [],
              slashCommands: [],
            },
          ],
        })),
      },
    },
  ];
  fixture.thread = {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("factory-run-project"),
    title: "Factory run",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5-1",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [
      {
        id: MessageId.make("factory-run-approve"),
        role: "user" as const,
        text: "Build the approved plan",
        turnId: null,
        streaming: false,
        createdAt: "2026-09-28T08:58:00.000Z",
        updatedAt: "2026-09-28T08:58:00.000Z",
      },
    ],
    proposedPlans: [],
    checkpoints: [],
    pullRequests: [],
    createdAt: "2026-09-28T08:58:00.000Z",
    updatedAt: "2026-09-28T08:58:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    activities: [],
  } as Thread;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  useComposerDraftStore.getState().clearComposerContent(scopeThreadRef(environmentId, threadId));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountApp() {
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
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
}

/** The run card's own timeline row. */
function runRow(): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-timeline-row="${runRowId}"]`);
  expect(row, `Expected the run card's row; rendered: ${container.textContent}`).not.toBeNull();
  return row!;
}

function markLabels(row: HTMLElement): string[] {
  return [...row.querySelectorAll<HTMLElement>("[aria-label^='Phase ']")].map(
    (mark) => mark.getAttribute("aria-label") ?? "",
  );
}

it("phase8 web AC1 renders a factory.run activity as a run card with its request, status, phase, node, marks, returns, cost and last event", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("verify")] };
  await mountApp();
  const text = runRow().textContent ?? "";

  expect(text).toContain(REQUEST);
  expect(text).toContain("phase 1/2 · Verify ①");
  expect(text).toContain("Serialize the filtered invoice list as CSV");
  expect(text).toContain("1/5 returns");
  expect(text).toContain("$10.03");
  expect(markLabels(runRow())).toEqual(["Phase 1: running", "Phase 2: pending"]);
  expect(runRow().querySelector('time[datetime="2026-09-28T10:18:00.000Z"]')).not.toBeNull();
  // One card, never a work-log row: the activity's summary is not shown anywhere.
  expect(container.textContent).not.toContain("Software Factory run");
});

it("phase8 web AC1 marks a finished run's phases clean and degraded", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("degraded")] };
  await mountApp();

  expect(runRow().textContent).toContain("degraded");
  expect(markLabels(runRow())).toEqual(["Phase 1: clean", "Phase 2: degraded"]);
});

it("phase8 web AC3 shows the stop question on the run card and reads waiting", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("waiting")] };
  await mountApp();
  const text = runRow().textContent ?? "";

  expect(text).toContain("waiting");
  expect(text).toContain("Name the file after the filter range or after the export date?");
});

it("phase8 web AC6 updates the run card in place as events arrive without remounting its row", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("verify")] };
  await mountApp();
  const row = runRow();
  const card = row.firstElementChild;
  expect(card).not.toBeNull();

  await showRunAt("review");
  expect(runRow()).toBe(row);
  expect(row.firstElementChild).toBe(card);
  expect(row.textContent).toContain("phase 1/2 · Review");
  expect(row.textContent).not.toContain("Verify ①");

  await showRunAt("waiting");
  expect(runRow()).toBe(row);
  expect(row.firstElementChild).toBe(card);
  expect(row.textContent).toContain(
    "Name the file after the filter range or after the export date?",
  );
});

it("phase8 web run card of a summary without phase marks renders without marks", async () => {
  fixture.thread = {
    ...fixture.thread!,
    activities: [
      makeFactoryRunActivity({
        threadId,
        summary: withoutFactoryRunMarks(makeFactoryRunSummary(eventsJsonl, "verify")),
      }),
    ],
  };
  await mountApp();

  expect(markLabels(runRow())).toEqual([]);
  expect(runRow().textContent).toContain("phase 1/2 · Verify ①");
  expect(runRow().textContent).toContain(REQUEST);
});
