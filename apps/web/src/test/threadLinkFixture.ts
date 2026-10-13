import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";
import type {
  EnvironmentId,
  PreviewOpenLinkTargetResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { applyPreviewServerEvent, readThreadPreviewState } from "~/previewStateStore";
import { createPreviewNavigationTransport } from "~/browser/previewNavigationTransport";
import { registerThreadLinkTransport } from "~/browser/threadLinkNavigation";

export function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Replace connection/auth/server reads at the boundary. Reconciliation, panel
// ownership, mounted transport and status delivery remain the production paths.
export const threadLinkFixture = {
  configs: Atom.make(
    new Map<
      EnvironmentId,
      { environment: { capabilities: { serverBrowser?: boolean; threadLinkPreview?: boolean } } }
    >(),
  ).pipe(Atom.keepAlive),
  catalog: Atom.make({ entries: new Map<EnvironmentId, object>(), isReady: true }).pipe(
    Atom.keepAlive,
  ),
  permission: Atom.family((_id: EnvironmentId) => Atom.make(true).pipe(Atom.keepAlive)),
  connection: Atom.family((_id: EnvironmentId) =>
    Atom.make(
      AsyncResult.success({
        phase: "connected",
        generation: 1,
      }),
    ).pipe(Atom.keepAlive),
  ),
  prepared: Atom.family((_id: EnvironmentId) =>
    Atom.make(Option.some({ lease: {}, httpBaseUrl: "https://fixture.invalid" })).pipe(
      Atom.keepAlive,
    ),
  ),
};

export function installThreadLinkEnvironment(ref: ScopedThreadRef) {
  const f = threadLinkFixture;
  appAtomRegistry.set(
    f.configs,
    new Map([
      ...appAtomRegistry.get(f.configs),
      [
        ref.environmentId,
        { environment: { capabilities: { serverBrowser: true, threadLinkPreview: true } } },
      ],
    ]),
  );
  appAtomRegistry.set(f.catalog, {
    isReady: true,
    entries: new Map([...appAtomRegistry.get(f.catalog).entries, [ref.environmentId, {}]]),
  });
  appAtomRegistry.set(f.permission(ref.environmentId), true);
  appAtomRegistry.set(
    f.connection(ref.environmentId),
    AsyncResult.success({ phase: "connected", generation: 1 }),
  );
  appAtomRegistry.set(
    f.prepared(ref.environmentId),
    Option.some({ lease: {}, httpBaseUrl: "https://fixture.invalid" }),
  );
}

export function linkEnvelope(
  ref: ScopedThreadRef,
  tabId = "shared-target",
  revision = 1,
): PreviewOpenLinkTargetResult {
  return {
    selectedTabId: tabId,
    serverEpoch: "epoch-1",
    revision,
    sessions: [
      {
        threadId: ref.threadId,
        tabId,
        purpose: "thread-link",
        runtime: "server",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    ],
  };
}

export function mountThreadLinkStream(
  ref: ScopedThreadRef,
  onNavigate: (url: string) => void = () => {},
) {
  const target = { threadRef: ref, serverEpoch: "epoch-1", tabId: "shared-target" };
  const surface = {
    readiness: () => "ready" as const,
    navigate: (url: string) => {
      onNavigate(url);
      const state = readThreadPreviewState(ref);
      applyPreviewServerEvent(ref, {
        type: "navigated",
        threadId: ref.threadId,
        tabId: target.tabId,
        createdAt: "2026-10-12T00:00:01.000Z",
        serverEpoch: target.serverEpoch,
        revision: state.serverRevision + 1,
        snapshot: {
          ...state.sessions[target.tabId]!,
          navStatus: { _tag: "Loading", url, title: "" },
          updatedAt: new Date(
            Date.parse("2026-10-12T00:00:00.000Z") + state.serverRevision + 1,
          ).toISOString(),
        },
      });
      return true;
    },
    history: () => {},
    reload: () => {},
    viewport: () => {},
    canvas: () => null,
  };
  return registerThreadLinkTransport(
    target,
    createPreviewNavigationTransport({
      target,
      streamed: true,
      surface: () => surface,
      bridge: null,
    }),
  );
}

// Only the external socket is synthetic. The stream client, surface effects,
// transport registry and preview status delivery stay in their production paths.
export class ThreadLinkTestSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: ThreadLinkTestSocket;
  static instances: ThreadLinkTestSocket[] = [];
  readyState = 1;
  binaryType = "";
  sent: string[] = [];
  constructor(readonly url: string) {
    super();
    ThreadLinkTestSocket.current = this;
    ThreadLinkTestSocket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  control(value: PreviewStreamControl) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ type: "control", ...value }) }),
    );
  }
}
