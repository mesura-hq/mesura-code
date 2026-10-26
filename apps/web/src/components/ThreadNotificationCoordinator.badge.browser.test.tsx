import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, THREAD_SEARCH_PROJECT_ID, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal, type Screen } from "../../test/render";
import { knownPushRegistration } from "../pushNotifications/pushRegistration";
import { threadNotificationTag } from "../threadNotifications";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  environmentIds: ["one", "two"],
  noDelegated: new Set(),
  openSearch: vi.fn(),
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => ({})) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast as never } };
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
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => state.environmentIds) as never,
}));
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      pendingSubagentRequestsAtom: (() => noRequestsAtom) as never,
    },
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useDelegatedUnderParent: (() => state.noDelegated) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((
    select: (settings: { notificationMode: string; inAppNotificationsEnabled: boolean }) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp })) as never,
  getClientSettings: (() => ({ notificationMode: state.mode })) as never,
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

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const noRequestsAtom = Atom.make(new Map());
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
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
  agentSignal: null as {
    kind: "needs_input" | "ready_to_close";
    note: string | null;
    runId: string | null;
    setAt: string;
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
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
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
// The mocked modules read `state`, the registry and the focus flags, so every test starts by
// resetting them. The first render is left to the test because some tests change state first.
function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.environmentIds = ["one", "two"];
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
  const ui = () => (
    <RegistryContext.Provider value={testRegistry}>
      <ThreadNotificationCoordinator />
    </RegistryContext.Provider>
  );
  let screen: Screen | undefined;
  return {
    async render() {
      if (screen) await screen.rerender(ui());
      else screen = stack.use(await render(ui()));
    },
    unmount: () => screen!.unmount(),
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when notifications are disabled",
  async (flag) => {
    await using app = setup();
    await app.render();
    state.shells.set("one", shell({ [flag]: true }));
    await app.render();
    expect(state.badge).toHaveBeenLastCalledWith(1);
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    await app.render();
    expect(state.badge).toHaveBeenLastCalledWith(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

it("notifies a new needs_input agent signal as Input needed, once", async () => {
  await using app = setup();
  await app.render();
  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
  };
  state.shells.set("one", shell(completed));
  await app.render();
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Thread completed"]);
  const agentSignal = {
    kind: "needs_input" as const,
    note: "Which database should the migration target?",
    runId: "turn",
    setAt: "2026-09-13T07:01:00.000Z",
  };
  state.shells.set("one", shell({ ...completed, agentSignal }));
  await app.render();
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual([
    "Thread completed",
    "Input needed",
  ]);
  state.shells.set("one", shell({ ...completed, agentSignal: { ...agentSignal } }));
  await app.render();
  expect(TestNotification.sent).toHaveLength(2);
});

// regression: phase 3 review P1-1 — the run's completion replaced the agent's Input needed.
it("keeps Input needed when the run that signalled needs_input completes", async () => {
  await using app = setup();
  await app.render();
  const agentSignal = {
    kind: "needs_input" as const,
    note: "Which database should the migration target?",
    runId: "turn",
    setAt: "2026-09-13T07:00:30.000Z",
  };
  state.shells.set("one", shell({ agentSignal }));
  await app.render();
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
  state.shells.set(
    "one",
    shell({
      agentSignal,
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  await app.render();
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
  // Dismissing the signal later announces nothing: the completion was already recorded.
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  await app.render();
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
  await app.render();

  state.shells.set("one", shell(searchCompleted));
  await app.render();

  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Agent search finished"]);
});

it("agent search notification spec: a settled search thread is never announced as Thread completed in app", async () => {
  await using app = setup();
  state.inApp = true;
  focused = true;
  state.shells.set("one", shell(searchThread));
  await app.render();

  state.shells.set("one", shell(searchCompleted));
  await app.render();

  const titles = state.toast.mock.calls.map(([toast]) => (toast as { title?: string }).title);
  expect(titles).not.toContain("Thread completed");
  expect(TestNotification.sent.map((entry) => entry.title)).not.toContain("Thread completed");
});

it("agent search notification guard: an ordinary thread settling beside a search still notifies Thread completed", async () => {
  await using app = setup();
  state.shells.set("one", shell({}, searchThread));
  await app.render();

  state.shells.set(
    "one",
    shell(
      {
        latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
      },
      searchThread,
    ),
  );
  await app.render();

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
  using _worker = stubServiceWorkerRegistration({ scope: `${location.origin}/`, showNotification });
  await app.render();

  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await app.render();

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
  await app.render();

  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await app.render();

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
  await app.render();

  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await app.render();
  await vi.waitFor(() => expect(state.badge).toHaveBeenLastCalledWith(1));
  state.shells.set("one", shell({ hasPendingUserInput: true }));
  await app.render();

  await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(registration.shown.get(THREAD_TAG)?.title).toBe("Input needed"));
  expect(state.badge).toHaveBeenLastCalledWith(1);
});

// regression: phase 2 review P1-2 — a worker registered in another tab was never seen here.
it("page notification regression: a worker that claims the page after it mounted shows the next notification", async () => {
  await using app = setup();
  using worker = stubServiceWorkerRegistration(undefined);
  await app.render();
  const registration = persistentRegistration();
  worker.claimedBy(registration);
  await vi.waitFor(() => expect(knownPushRegistration()).toBe(registration));

  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await app.render();

  await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledTimes(1));
  expect(TestNotification.sent).toHaveLength(0);
});

// regression: phase 2 review P1-3 — a worker notification for an agent search lost its popup.
it("page notification regression: a worker notification for an agent search carries the search target", async () => {
  await using app = setup();
  const registration = persistentRegistration();
  using _worker = stubServiceWorkerRegistration(registration);
  state.shells.set("one", shell(searchThread));
  await app.render();

  state.shells.set("one", shell(searchCompleted));
  await app.render();

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
  await app.render();

  state.shells.set("one", shell(searchCompleted));
  await app.render();
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
  await app.render();
  await vi.waitFor(() => expect(knownPushRegistration()).toBe(registration));
  worker.unregisteredSilently();

  state.shells.set("one", shell({ hasPendingApprovals: true }));
  await app.render();
  await vi.waitFor(() => expect(knownPushRegistration()).toBeUndefined());
  state.shells.set("one", shell({ hasPendingUserInput: true }));
  await app.render();

  expect(registration.showNotification).toHaveBeenCalledTimes(1);
  expect(TestNotification.sent.map((entry) => entry.title)).toEqual(["Input needed"]);
});
