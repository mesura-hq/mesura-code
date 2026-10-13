import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createPreviewStreamClient,
  type PreviewStreamControl,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { EnvironmentId, ThreadId, type DesktopPreviewTabState } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  applyPreviewServerEvent,
  previewStateAtom,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { linkEnvelope, ThreadLinkTestSocket as Socket } from "~/test/threadLinkFixture";
import { createPreviewNavigationTransport } from "./previewNavigationTransport";
import { serverBrowserNavigation } from "./serverBrowserNavigation";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import {
  navigateThreadLink,
  notifyThreadLinkTransport,
  registerThreadLinkTransport,
  ThreadLinkCancelled,
  ThreadLinkNavigationError,
} from "./threadLinkNavigation";

// Real stream client, production address-bar adapter and preview store. Only
// WebSocket/IPC delivery is synthetic; this suite makes no pixel/OS-focus claim.
const ref = {
  environmentId: EnvironmentId.make("transport-env"),
  threadId: ThreadId.make("transport-thread"),
};
const target = { threadRef: ref, serverEpoch: "epoch-1", tabId: "shared-target" };
const url = "https://example.com/docs";
const runtimeId = previewRuntimeTabId(ref, target.serverEpoch, target.tabId);
const stops: Array<() => void> = [];
const controllers: AbortController[] = [];
beforeEach(() => {
  vi.stubGlobal("WebSocket", Socket);
  resetPreviewStateForTests();
  reconcilePreviewServerSessions(ref, linkEnvelope(ref));
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const stop of stops.splice(0).toReversed()) stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function signal() {
  const controller = new AbortController();
  controllers.push(controller);
  return controller;
}
function observation(kind: "Loading" | "LoadFailed" = "Loading") {
  const state = readThreadPreviewState(ref);
  const snapshot = state.sessions[target.tabId]!;
  applyPreviewServerEvent(ref, {
    type: "navigated",
    threadId: ref.threadId,
    tabId: target.tabId,
    createdAt: "2026-10-12T00:00:01Z",
    serverEpoch: target.serverEpoch,
    revision: state.serverRevision + 1,
    snapshot: {
      ...snapshot,
      updatedAt: "2026-10-12T00:00:01Z",
      navStatus:
        kind === "Loading"
          ? { _tag: "Loading", url, title: "" }
          : { _tag: "LoadFailed", url, title: "", code: -1, description: "Synthetic refusal" },
    },
  });
}
function stream() {
  let control: PreviewStreamControl | null = null;
  let connectionGeneration = 0;
  const client = createPreviewStreamClient(
    {
      access: {
        httpBase: "https://fixture.invalid/api/preview-stream",
        wsBase: "wss://fixture.invalid/api/preview-stream",
        query: {},
        credentials: true,
      },
      threadId: ref.threadId,
      tabId: target.tabId,
      maxWidth: 800,
      maxHeight: 600,
    },
    {
      onFrame: () => {},
      onViewport: () => {},
      onUnauthorized: () => {},
      onControl: (next) => {
        control = next;
        notifyThreadLinkTransport();
      },
      onConnectedChange: (connected) => {
        if (!connected) {
          connectionGeneration += 1;
          control = null;
          notifyThreadLinkTransport();
        }
      },
    },
  );
  stops.push(() => client.stop());
  const surface = {
    ...serverBrowserNavigation(
      () => client,
      () => control,
    ),
    history: () => {},
    reload: () => {},
    viewport: () => {},
    canvas: () => null,
  };
  stops.push(
    registerThreadLinkTransport(
      target,
      createPreviewNavigationTransport({
        target,
        streamed: true,
        surface: () => surface,
        bridge: null,
        connectionGeneration: () => connectionGeneration,
      }),
    ),
  );
  return Socket.current;
}
function grant(
  socket: Socket,
  controller: PreviewStreamControl["controller"] = "you",
  canOperate = true,
) {
  socket.control({ canOperate, controller, generation: 1, dialog: null });
}

it("thread link transport guard: a disconnect before the first control grant cancels its existing waiter", async () => {
  const socket = stream();
  socket.dispatchEvent(new Event("open"));
  const owner = signal();
  let cancelled = false;
  const opening = navigateThreadLink(target, url, owner.signal).catch((error: unknown) => {
    cancelled = error instanceof ThreadLinkCancelled;
  });
  try {
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(socket.sent).toEqual([]);
  } finally {
    owner.abort();
    await opening;
  }
});

it("thread link transport guard: socket grant and a fresh Loading status are separate acceptance milestones", async () => {
  const socket = stream();
  let completed = false;
  const opening = navigateThreadLink(target, url, signal().signal).then(() => {
    completed = true;
  });
  expect(socket.sent).toEqual([]);
  grant(socket);
  await Promise.resolve();
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([{ type: "navigate", url }]);
  expect(completed).toBe(false);
  observation();
  await opening;
  expect(completed).toBe(true);
});
it.each(["another-viewer", "agent", "unclaimed"] as const)(
  "thread link transport guard: %s ownership refuses without takeover or navigation",
  async (owner) => {
    const socket = stream();
    grant(socket, owner);
    await expect(navigateThreadLink(target, url, signal().signal)).rejects.toBeInstanceOf(
      ThreadLinkNavigationError,
    );
    expect(socket.sent).toEqual([]);
  },
);
it("thread link transport guard: operation grant denial refuses even when controller says you", async () => {
  const socket = stream();
  grant(socket, "you", false);
  await expect(navigateThreadLink(target, url, signal().signal)).rejects.toBeInstanceOf(
    ThreadLinkNavigationError,
  );
  expect(socket.sent).toEqual([]);
});
it("thread link transport guard: pre-existing same-URL Success cannot acknowledge a new request", async () => {
  const envelope = linkEnvelope(ref);
  reconcilePreviewServerSessions(ref, {
    ...envelope,
    revision: 2,
    sessions: [
      { ...envelope.sessions[0]!, navStatus: { _tag: "Success", url, title: "Existing page" } },
    ],
  });
  const socket = stream();
  grant(socket);
  let accepted = false;
  const opening = navigateThreadLink(target, url, signal().signal).then(() => {
    accepted = true;
  });
  await Promise.resolve();
  expect(accepted).toBe(false);
  expect(socket.sent).toHaveLength(1);
  observation();
  await opening;
  expect(accepted).toBe(true);
});
it("thread link transport guard: fresh LoadFailed reports failure instead of a visit milestone", async () => {
  const socket = stream();
  grant(socket);
  const opening = navigateThreadLink(target, url, signal().signal);
  const assertion = expect(opening).rejects.toBeInstanceOf(ThreadLinkNavigationError);
  observation("LoadFailed");
  await assertion;
});
it("thread link transport guard: loss of control after submission cancels instead of falling back", async () => {
  const socket = stream();
  grant(socket);
  const opening = navigateThreadLink(target, url, signal().signal);
  const assertion = expect(opening).rejects.toBeInstanceOf(ThreadLinkCancelled);
  grant(socket, "another-viewer");
  await assertion;
  expect(socket.sent).toHaveLength(1);
});
it("thread link transport guard: replacing a waiting mounted instance cancels its intent", async () => {
  stream();
  const opening = navigateThreadLink(target, url, signal().signal);
  const assertion = expect(opening).rejects.toBeInstanceOf(ThreadLinkCancelled);
  stream();
  await assertion;
});
it("thread link transport guard: an off-route waiter remains bounded and never uses an unrelated viewer", async () => {
  vi.useFakeTimers();
  try {
    const socket = stream();
    grant(socket);
    const other = { ...target, threadRef: { ...ref, threadId: ThreadId.make("off-route") } };
    const opening = navigateThreadLink(other, url, signal().signal);
    const assertion = expect(opening).rejects.toBeInstanceOf(ThreadLinkNavigationError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(socket.sent).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

function native() {
  const listeners = new Set<(id: string, state: DesktopPreviewTabState) => void>();
  const navigate = vi.fn(async (_id: string, _url: string) => {});
  const bridge = {
    navigate,
    onStateChange: (listener: (id: string, state: DesktopPreviewTabState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  stops.push(
    registerThreadLinkTransport(
      target,
      createPreviewNavigationTransport({ target, streamed: false, surface: () => null, bridge }),
    ),
  );
  const registered = () => {
    const state = readThreadPreviewState(ref);
    appAtomRegistry.set(previewStateAtom(scopedThreadKey(ref)), {
      ...state,
      desktopByTabId: {
        [target.tabId]: {
          hasWebContents: true,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          zoomFactor: 1,
          pictureInPicture: false,
          colorScheme: "system",
          audioMuted: false,
          audible: false,
          controller: "human",
          favicon: null,
        },
      },
    });
    notifyThreadLinkTransport();
  };
  const emit = (id = runtimeId, kind: "Loading" | "Success" = "Loading") => {
    const state: DesktopPreviewTabState = {
      tabId: target.tabId,
      webContentsId: 42,
      navStatus: { kind, url, title: "" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "human",
      updatedAt: "2026-10-12T00:00:01Z",
    };
    for (const listener of listeners) listener(id, state);
  };
  return { navigate, registered, emit, listeners };
}
it("thread link native guard: Idle waits for the exact native registration and bridge resolution alone is not acceptance", async () => {
  const host = native();
  let accepted = false;
  const opening = navigateThreadLink(target, url, signal().signal).then(() => {
    accepted = true;
  });
  expect(host.navigate).not.toHaveBeenCalled();
  host.registered();
  await Promise.resolve();
  expect(host.navigate).toHaveBeenCalledExactlyOnceWith(runtimeId, url);
  expect(accepted).toBe(false);
  host.emit("unrelated-runtime");
  host.emit(runtimeId, "Success");
  await Promise.resolve();
  expect(accepted).toBe(false);
  host.emit();
  await opening;
  expect(host.listeners.size).toBe(0);
});
it("thread link native guard: every same-URL activation requires its own fresh Loading/reload observation", async () => {
  const host = native();
  host.registered();
  const first = navigateThreadLink(target, url, signal().signal);
  host.emit();
  await first;
  let accepted = false;
  const second = navigateThreadLink(target, url, signal().signal).then(() => {
    accepted = true;
  });
  await Promise.resolve();
  expect(accepted).toBe(false);
  host.emit();
  await second;
  expect(host.navigate).toHaveBeenCalledTimes(2);
  expect(host.listeners.size).toBe(0);
});
it("thread link native guard: unmount during Idle attachment cannot navigate a later replacement", async () => {
  const host = native();
  const opening = navigateThreadLink(target, url, signal().signal);
  const assertion = expect(opening).rejects.toBeInstanceOf(ThreadLinkCancelled);
  stops.pop()!();
  await assertion;
  host.registered();
  expect(host.navigate).not.toHaveBeenCalled();
  expect(host.listeners.size).toBe(0);
});
