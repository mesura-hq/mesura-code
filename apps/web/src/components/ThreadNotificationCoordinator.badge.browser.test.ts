import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import type { AnyRouter } from "@tanstack/react-router";
import { EnvironmentId, THREAD_SEARCH_PROJECT_ID, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../../test/render";
import { knownPushRegistration } from "../pushNotifications/pushRegistration";
import { threadNotificationTag } from "../threadNotifications";
import { RELEASED_COMPLETION_GRACE_MS } from "./ThreadNotificationCoordinator.logic";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  closeToast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
  openSearch: vi.fn(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: state.toast as never,
      close: state.closeToast as never,
    },
  };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      pendingSubagentRequestsAtom: (() => noRequestsAtom) as never,
      get delegatedUnderParentAtom() {
        return noDelegatedAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  })) as never,
}));
vi.mock(import("./searches/agentSearchNotification"), async (original) => ({
  ...(await original()),
  openAgentSearch: state.openSearch,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);
const noRequestsAtom = Atom.make(new Map());
const noDelegatedAtom = Atom.make<ReadonlySet<string>>(new Set<string>());
state.shells = { set: (id, value) => registry.set(shellAtom(id), value) };

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

const thread = {
  id: "thread",
  projectId: "project",
  title: "Test thread",
  archivedAt: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingRequestId: "request-1",
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
  agentSignal: null as {
    kind: "needs_input" | "ready_to_close";
    note: string | null;
    runId: string | null;
    setAt: string;
  } | null,
  factoryRun: null as {
    status: "running" | "waiting" | "stopped";
    phaseIndex: number;
    phaseCount: number;
    node: string | null;
    askedAt: string | null;
  } | null,
};
let focused = false;
let visibility = "visible";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "preparing"
          ? "preparing"
          : latestTurn.state === "error" || input.session?.status === "error"
            ? "failed"
            : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: input.pendingRequestId, kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: input.pendingRequestId, kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    agentSignal: input.agentSignal,
    ...(input.factoryRun === null ? {} : { factoryRun: input.factoryRun }),
  };
}

function shell(overrides: Partial<typeof thread> = {}, ...others: Partial<typeof thread>[]) {
  return {
    status: "live",
    snapshot: Option.some({
      threads: [overrides, ...others].map((override) =>
        toV2ThreadShell({ ...thread, ...override }),
      ),
    }),
  };
}
// The mocked modules read `state` and the focus flags, so every test resets them before
// starting the service.
function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.settingsListeners.clear();
  registry.set(environmentIdsAtom, ["one", "two"]);
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility as DocumentVisibilityState),
  );
  const routeListeners = new Set<() => void>();
  const route = { params: {} as Record<string, string> };
  const router = {
    state: { matches: [route] },
    navigate: state.navigate,
    subscribe: (_event: string, listener: () => void) => {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
  } as unknown as AnyRouter;
  return {
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
    openThread: (environmentId: string, threadId: string) => {
      route.params = { environmentId, threadId };
      for (const listener of routeListeners) listener();
    },
    changeSettings: () => {
      for (const listener of state.settingsListeners) listener();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when notifications are disabled",
  async (flag) => {
    await using app = setup();
    app.start();
    state.shells.set("one", shell({ [flag]: true }));
    expect(state.badge).toHaveBeenLastCalledWith(1);
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    app.changeSettings();
    expect(state.badge).toHaveBeenLastCalledWith(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "notifies once per %s request, not again as queued runs start behind it",
  async (flag) => {
    await using app = setup();
    app.start();
    const waiting = (turnId: string, pendingRequestId: string) =>
      shell({
        [flag]: true,
        pendingRequestId,
        latestTurn: { turnId, state: "running", completedAt: null },
      });
    state.shells.set("one", waiting("turn-1", "request-1"));
    state.shells.set("one", waiting("turn-2", "request-1"));
    state.shells.set("one", waiting("turn-2", "request-2"));
    const title = flag === "hasPendingApprovals" ? "Approval needed" : "Input needed";
    expect(TestNotification.sent.map(({ title }) => title)).toEqual([title, title]);
  },
);

it("presents completion notifications and sound as soon as the shell completes", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  app.start();
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:00:01.000Z" },
    }),
  );
  expect(TestNotification.sent.map((sent) => sent.title)).toEqual(["Thread completed"]);
  expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
});

it.each([false, true])(
  "presents one completion when a monitor ends with a final wake (disconnected: %s)",
  async (disconnect) => {
    await using app = setup();
    using _timers = fakeTimers();
    state.mode = "notifications-and-sound";
    app.start();
    const watching = (
      turnId: string,
      turnState: string,
      completedAt: string | null,
      latestRunBackgroundWake: boolean,
      pendingBackgroundTasks: ReadonlyArray<{ taskId: string; kind: "monitor" }>,
    ) => ({
      status: "live",
      snapshot: Option.some({
        threads: [
          {
            ...toV2ThreadShell({
              ...thread,
              latestTurn: { turnId, state: turnState, completedAt },
            }),
            latestRunBackgroundWake,
            pendingBackgroundTasks,
          },
        ],
      }),
    });
    const monitor = [{ taskId: "watch", kind: "monitor" as const }];
    const titles = () => TestNotification.sent.map(({ title }) => title);
    state.shells.set(
      "one",
      watching("turn", "completed", "2026-09-13T07:00:01.000Z", false, monitor),
    );
    // Mesura holds the initial turn while its monitor remains pending. Upstream announces
    // that turn too, but this fork announces only when the monitored work finishes.
    expect(titles()).toEqual([]);

    state.shells.set("one", watching("wake", "running", null, true, monitor));
    state.shells.set(
      "one",
      watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, monitor),
    );
    expect(titles()).toEqual([]);

    // The adapter drains the roster before the final wake starts.
    state.shells.set("one", watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, []));
    expect(titles()).toEqual([]);
    if (disconnect) {
      state.shells.set("one", {
        ...watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, []),
        status: "cached",
      });
      vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
      expect(titles()).toEqual([]);
    }

    state.shells.set("one", watching("final", "running", null, false, []));
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(titles()).toEqual([]);
    expect(state.sound).not.toHaveBeenCalled();
    state.shells.set("one", watching("final", "completed", "2026-09-13T07:00:11.000Z", false, []));
    expect(titles()).toEqual(["Thread completed"]);
    expect(state.sound).toHaveBeenCalledTimes(1);

    const completed = watching("final", "completed", "2026-09-13T07:00:11.000Z", false, []);
    if (disconnect) state.shells.set("one", { ...completed, status: "cached" });
    state.shells.set("one", completed);
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(titles()).toEqual(["Thread completed"]);
    expect(state.sound).toHaveBeenCalledTimes(1);
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "notifies for offline completion and %s once across reconnects",
  async (flag) => {
    await using app = setup();
    const asking = { id: "asking", hasPendingApprovals: true };
    const offline = { id: "offline", [flag]: true };
    const done = {
      id: "done",
      latestTurn: {
        turnId: "done-turn",
        state: "completed",
        completedAt: "2026-09-13T07:00:00.000Z",
      },
    };
    state.shells.set("one", shell({ id: "working" }, { id: "asking" }, { id: "offline" }, done));
    app.start();
    state.shells.set("one", shell({ id: "working" }, asking, { id: "offline" }, done));
    state.shells.set("one", {
      ...shell({ id: "working" }, asking, { id: "offline" }, done),
      status: "cached",
    });

    const completed = {
      id: "working",
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:05:00.000Z" },
    };
    state.shells.set("one", {
      ...shell(completed, asking, offline, done),
      status: "synchronizing",
    });
    state.shells.set("one", shell(completed, asking, offline, done));

    expect(TestNotification.sent.map(({ title }) => title)).toEqual([
      "Approval needed",
      "Thread completed",
      flag === "hasPendingApprovals" ? "Approval needed" : "Input needed",
    ]);
    state.shells.set("one", { ...shell(completed, asking, offline, done), status: "cached" });
    state.shells.set("one", shell(completed, asking, offline, done));
    expect(TestNotification.sent.map(({ title }) => title)).toEqual([
      "Approval needed",
      "Thread completed",
      flag === "hasPendingApprovals" ? "Approval needed" : "Input needed",
    ]);
  },
);

it.each([false, true])(
  "does not replay a notified completion after reconnect (continued: %s)",
  async (continued) => {
    await using app = setup();
    app.start();
    const completed = shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:05:00.000Z" },
    });
    state.shells.set("one", completed);
    state.shells.set("one", { ...completed, status: "cached" });
    expect(TestNotification.sent.map(({ title }) => title)).toEqual(["Thread completed"]);
    state.shells.set("one", continued ? shell() : completed);
    expect(TestNotification.sent.map(({ title }) => title)).toEqual(["Thread completed"]);
  },
);

it("opening a thread or removing its environment closes only its in-app toasts, and disabling notifications closes the rest", async () => {
  await using app = setup();
  state.inApp = true;
  focused = true;
  state.toast
    .mockReturnValueOnce("one-completed")
    .mockReturnValueOnce("one-approval")
    .mockReturnValueOnce("one-other")
    .mockReturnValueOnce("two-completed");
  state.shells.set("one", shell({}, { id: "other" }));
  app.start();
  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00Z" },
  };
  state.shells.set("one", shell(completed, { id: "other" }));
  state.shells.set("one", shell({ ...completed, hasPendingApprovals: true }, { id: "other" }));
  state.shells.set(
    "one",
    shell({ ...completed, hasPendingApprovals: true }, { ...completed, id: "other" }),
  );
  state.shells.set("two", shell(completed));
  expect(state.toast).toHaveBeenCalledTimes(4);

  app.openThread("one", "thread");
  expect(state.closeToast.mock.calls).toEqual([["one-completed"], ["one-approval"]]);

  app.setEnvironmentIds(["one"]);
  expect(state.closeToast.mock.calls.slice(2)).toEqual([["two-completed"]]);

  state.mode = "off";
  state.inApp = false;
  app.changeSettings();
  expect(state.closeToast.mock.calls.slice(3)).toEqual([["one-other"]]);
});

it("notifies a new needs_input agent signal as Input needed, once", async () => {
  await using app = setup();
  app.start();
  using _timers = fakeTimers();
  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
  };
  state.shells.set("one", shell(completed));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Thread completed"]);
  const agentSignal = {
    kind: "needs_input" as const,
    note: "Which database should the migration target?",
    runId: "turn",
    setAt: "2026-09-13T07:01:00.000Z",
  };
  state.shells.set("one", shell({ ...completed, agentSignal }));
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual([
    "Thread completed",
    "Input needed",
  ]);
  state.shells.set("one", shell({ ...completed, agentSignal: { ...agentSignal } }));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent).toHaveLength(2);
});

it("a ready_to_close signal adds no notification and preserves the normal completion", async () => {
  await using app = setup();
  app.start();
  using _timers = fakeTimers();
  const agentSignal = {
    kind: "ready_to_close" as const,
    note: null,
    runId: "turn",
    setAt: "2026-09-13T07:00:30.000Z",
  };
  state.shells.set("one", shell({ agentSignal }));
  expect(TestNotification.sent).toHaveLength(0);
  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
  };
  state.shells.set("one", shell({ ...completed, agentSignal }));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Thread completed"]);
  state.shells.set("one", shell({ ...completed, agentSignal: null }));
  expect(TestNotification.sent).toHaveLength(1);
});

// regression: phase 3 review P1-1 — the run's completion replaced the agent's Input needed.
// Mesura: a question signalled mid-turn notifies once the agent stops executing (2026-11-01).
it("notifies Input needed, not a completion, when the run that signalled needs_input completes", async () => {
  await using app = setup();
  app.start();
  using _timers = fakeTimers();
  const agentSignal = {
    kind: "needs_input" as const,
    note: "Which database should the migration target?",
    runId: "turn",
    setAt: "2026-09-13T07:00:30.000Z",
  };
  state.shells.set("one", shell({ agentSignal }));
  expect(TestNotification.sent).toHaveLength(0);
  state.shells.set(
    "one",
    shell({
      agentSignal,
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
  // Dismissing the signal later announces nothing: the completion was already recorded.
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
});

// Seal re-check P1-3: the sidebar reads Needs input while a thread prepares, but the
// question notifies only once the agent stops executing, as it did before.
it("notifies a needs_input signal raised while preparing once, after the run completes", async () => {
  await using app = setup();
  app.start();
  using _timers = fakeTimers();
  const agentSignal = {
    kind: "needs_input" as const,
    note: "Which branch?",
    runId: "turn",
    setAt: "2026-09-13T07:00:30.000Z",
  };
  state.shells.set(
    "one",
    shell({ agentSignal, latestTurn: { turnId: "turn", state: "preparing", completedAt: null } }),
  );
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent).toHaveLength(0);
  state.shells.set("one", shell({ agentSignal }));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent).toHaveLength(0);
  state.shells.set(
    "one",
    shell({
      agentSignal,
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
});

// Seal confirm P1-4: a Factory question notifies as soon as the run asks, even while the agent
// executes, as it did before; the agent's own signal waits for execution to end.
it("notifies a Factory stop that arrives while the agent executes at once, and once", async () => {
  await using app = setup();
  app.start();
  using _timers = fakeTimers();
  const factoryRun = {
    status: "stopped" as const,
    phaseIndex: 2,
    phaseCount: 13,
    node: "fence",
    askedAt: "2026-09-13T07:00:30.000Z",
  };
  state.shells.set("one", shell({ factoryRun }));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
  state.shells.set(
    "one",
    shell({
      factoryRun,
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
});

// Phase 3 of the search unification cycle, criterion 5: a finished agent search
// notifies like a finished thread, under its own title. The match count is not
// on the thread shell, so these specs pin the title and leave the body free.
const searchThread = { id: "search", projectId: THREAD_SEARCH_PROJECT_ID, title: "New search" };
const searchCompleted = {
  ...searchThread,
  latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
};

it("agent search notification spec: a settled search thread notifies Agent search finished", async () => {
  await using app = setup();
  state.shells.set("one", shell(searchThread));
  app.start();
  using _timers = fakeTimers();

  state.shells.set("one", shell(searchCompleted));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);

  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Agent search finished"]);
});

it("agent search notification spec: a settled search thread is never announced as Thread completed in app", async () => {
  await using app = setup();
  state.inApp = true;
  focused = true;
  state.shells.set("one", shell(searchThread));
  app.start();
  using _timers = fakeTimers();

  state.shells.set("one", shell(searchCompleted));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);

  const titles = state.toast.mock.calls.map(([toast]) => (toast as { title?: string }).title);
  expect(titles).not.toContain("Thread completed");
  expect(TestNotification.sent.map((entry) => entry.title)).not.toContain("Thread completed");
});

it("agent search notification guard: an ordinary thread settling beside a search still notifies Thread completed", async () => {
  await using app = setup();
  state.shells.set("one", shell({}, searchThread));
  app.start();
  using _timers = fakeTimers();

  state.shells.set(
    "one",
    shell(
      {
        latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
      },
      searchThread,
    ),
  );
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);

  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Thread completed"]);
});

// Phone push phase 2, criterion 6: page notifications go through the service
// worker registration when one exists, because Android Chrome throws on the
// `Notification` constructor. The desktop shell registers no worker, so it
// keeps the constructor path.
function stubServiceWorkerRegistration(initial: object | undefined): Disposable & {
  readonly claimedBy: (registration: object) => void;
  readonly unregisteredSilently: () => void;
} {
  const original = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  let registration = initial;
  const container = Object.assign(new EventTarget(), {
    controller: null,
    ready: registration ? Promise.resolve(registration) : new Promise(() => undefined),
    getRegistration: async () => registration,
    getRegistrations: async () => (registration ? [registration] : []),
  });
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  return {
    /** A worker registered elsewhere activates and claims this page. */
    claimedBy(next) {
      registration = next;
      container.dispatchEvent(new Event("controllerchange"));
    },
    /** The worker goes away, as an unregister from another tab does, with no event here. */
    unregisteredSilently() {
      registration = undefined;
    },
    [Symbol.dispose]() {
      if (original) Object.defineProperty(navigator, "serviceWorker", original);
      else Reflect.deleteProperty(navigator, "serviceWorker");
    },
  };
}

it("page notification spec: with a service worker registration, an approval shows through registration.showNotification with the thread route", async () => {
  await using app = setup();
  const showNotification = vi.fn(async (_title: string, _options?: NotificationOptions) => {});
  const registration = { scope: `${location.origin}/`, showNotification };
  using _worker = stubServiceWorkerRegistration(registration);
  app.start();
  await vi.waitFor(() => expect(knownPushRegistration()).toBe(registration));

  state.shells.set("one", shell({ hasPendingApprovals: true }));

  await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
  expect(showNotification).toHaveBeenCalledWith(
    "Approval needed",
    expect.objectContaining({
      body: "Test thread",
      tag: threadNotificationTag(EnvironmentId.make("one"), ThreadId.make("thread")),
      silent: true,
      data: expect.objectContaining({ url: "/one/thread" }),
    }),
  );
  expect(TestNotification.sent).toHaveLength(0);
});

it("page notification guard: with no service worker registration, an approval still uses the Notification constructor", async () => {
  await using app = setup();
  using _worker = stubServiceWorkerRegistration(undefined);
  app.start();
  await vi.waitFor(() => expect(knownPushRegistration()).toBeUndefined());

  state.shells.set("one", shell({ hasPendingApprovals: true }));

  await vi.waitFor(() =>
    expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Approval needed"]),
  );
  expect(TestNotification.sent[0]!.options.tag).toBe(
    threadNotificationTag(EnvironmentId.make("one"), ThreadId.make("thread")),
  );
});

/**
 * A worker registration as Chrome keeps it: one notification on screen per tag,
 * and every handle `getNotifications` returns for that tag closes that one.
 */
function persistentRegistration() {
  const shown = new Map<string, { title: string; options: NotificationOptions }>();
  return {
    shown,
    scope: `${location.origin}/`,
    showNotification: vi.fn(async (title: string, options: NotificationOptions = {}) => {
      shown.set(options.tag ?? "", { title, options });
    }),
    getNotifications: async ({ tag = "" }: { tag?: string } = {}) =>
      shown.has(tag) ? [{ tag, close: () => void shown.delete(tag) }] : [],
  };
}

const THREAD_TAG = threadNotificationTag(EnvironmentId.make("one"), ThreadId.make("thread"));

// regression: phase 2 review P1-1 — tracking a same-tag replacement closed the replacement.
it("page notification regression: a second worker notification for a thread stays on screen and counts once", async () => {
  await using app = setup();
  const registration = persistentRegistration();
  using _worker = stubServiceWorkerRegistration(registration);
  app.start();
  await vi.waitFor(() => expect(knownPushRegistration()).toBe(registration));

  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await vi.waitFor(() => expect(state.badge).toHaveBeenLastCalledWith(1));
  state.shells.set("one", shell({ hasPendingUserInput: true }));

  await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(registration.shown.get(THREAD_TAG)?.title).toBe("Input needed"));
  expect(state.badge).toHaveBeenLastCalledWith(1);
});

// regression: phase 2 review P1-2 — a worker registered in another tab was never seen here.
it("page notification regression: a worker that claims the page after it mounted shows the next notification", async () => {
  await using app = setup();
  using worker = stubServiceWorkerRegistration(undefined);
  app.start();
  await vi.waitFor(() => expect(knownPushRegistration()).toBeUndefined());
  const registration = persistentRegistration();
  worker.claimedBy(registration);
  await vi.waitFor(() => expect(knownPushRegistration()).toBe(registration));

  state.shells.set("one", shell({ hasPendingApprovals: true }));

  await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(1));
  expect(TestNotification.sent).toHaveLength(0);
});

// regression: phase 2 review P1-3 — a worker notification for an agent search lost its popup.
it("page notification regression: a worker notification for an agent search carries the search target", async () => {
  await using app = setup();
  const registration = persistentRegistration();
  using _worker = stubServiceWorkerRegistration(registration);
  state.shells.set("one", shell(searchThread));
  app.start();
  await vi.waitFor(() => expect(knownPushRegistration()).toBe(registration));
  using _timers = fakeTimers();

  state.shells.set("one", shell(searchCompleted));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);

  await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(1));
  expect(registration.showNotification).toHaveBeenCalledWith(
    "Agent search finished",
    expect.objectContaining({ data: { url: "/one/search?open=agent-search" } }),
  );
});

it("page notification guard: clicking a page notification for an agent search opens the search popup", async () => {
  await using app = setup();
  using _worker = stubServiceWorkerRegistration(undefined);
  state.shells.set("one", shell(searchThread));
  app.start();
  await vi.waitFor(() => expect(knownPushRegistration()).toBeUndefined());
  using _timers = fakeTimers();

  state.shells.set("one", shell(searchCompleted));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  TestNotification.sent[0]!.dispatchEvent(new Event("click"));

  expect(state.openSearch).toHaveBeenCalledWith(
    scopeThreadRef(EnvironmentId.make("one"), ThreadId.make("search")),
  );
  expect(state.navigate).not.toHaveBeenCalled();
});

// regression: phase 2 review P1-2 — a worker that went away kept every later notification on it.
it("page notification regression: after a worker refuses a notification, the next one uses the constructor", async () => {
  await using app = setup();
  const registration = persistentRegistration();
  registration.showNotification.mockRejectedValueOnce(new TypeError("No active worker"));
  using worker = stubServiceWorkerRegistration(registration);
  app.start();
  await vi.waitFor(() => expect(knownPushRegistration()).toBe(registration));
  worker.unregisteredSilently();

  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await vi.waitFor(() => expect(knownPushRegistration()).toBeUndefined());
  state.shells.set("one", shell({ hasPendingUserInput: true }));

  expect(registration.showNotification).toHaveBeenCalledTimes(1);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
});
