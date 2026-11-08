import type {
  EnvironmentId,
  PreviewOpenLinkTargetInput,
  PreviewOpenLinkTargetResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession, readPreparedConnection } from "~/state/session";
import { environmentServerConfigsAtom } from "~/state/server";
import { previewEnvironment } from "~/state/preview";
import {
  previewStateAtom,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  rememberPreviewUrl,
  setActivePreviewTab,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { recordVisitForThread } from "~/browserHistoryStore";
import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "./browserDefaults";
import {
  canOpenLinksInApp,
  readLinkClient,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "./browserLinkTarget";
import { BrowserSettingsReadError } from "./openFileInPreview";
import {
  navigateThreadLink,
  ThreadLinkCancelled,
  ThreadLinkNavigationError,
} from "./threadLinkNavigation";

export type AllocateThreadLink<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenLinkTargetInput;
}) => Promise<AtomCommandResult<PreviewOpenLinkTargetResult, E>>;

const actions = new Map<string, AbortController>();
function whileCurrent<A>(pending: Promise<A>, signal: AbortSignal): Promise<A> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new ThreadLinkCancelled());
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
const system = { _tag: "System" } as const;

async function readBrowserSettings<A>(read: () => Promise<A>, signal: AbortSignal): Promise<A> {
  try {
    return await whileCurrent(read(), signal);
  } catch (cause) {
    if (cause instanceof ThreadLinkCancelled) throw cause;
    throw new BrowserSettingsReadError({ cause });
  }
}

export async function openThreadLinkInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef | null | undefined;
  readonly url: string;
  readonly event?: { readonly metaKey: boolean; readonly ctrlKey: boolean };
  readonly explicitApp?: boolean;
  readonly allocate: AllocateThreadLink<E>;
  readonly ownerSignal?: AbortSignal;
}): Promise<
  AtomCommandResult<void, E | BrowserSettingsReadError | ThreadLinkNavigationError> | typeof system
> {
  if (input.ownerSignal?.aborted) return AsyncResult.failure(Cause.interrupt());
  const ref = input.threadRef;
  if (!ref) return system;
  const key = scopedThreadKey(ref);
  // A system activation is still the latest intent for this thread. Cancel a
  // pending app link before taking the immediate phone/modifier/system path.
  actions.get(key)?.abort();
  const targetFor = (preference: "app" | "system") =>
    resolveLinkTarget({
      url: input.url,
      event: input.event ?? { metaKey: false, ctrlKey: false },
      preference,
      linkClient: readLinkClient(),
      canOpenInApp: canOpenLinksInApp(ref),
    });
  if (targetFor("app") !== "app") return system;
  const action = new AbortController();
  actions.set(key, action);
  const stops: Array<() => void> = [];
  let cancelMaximize: (() => void) | undefined;
  let navigationAccepted = false;
  const cancelPendingMaximize = () => {
    const cancel = cancelMaximize;
    cancelMaximize = undefined;
    cancel?.();
  };
  action.signal.addEventListener("abort", cancelPendingMaximize, { once: true });
  const abort = () => {
    action.abort();
    cancelPendingMaximize();
  };
  input.ownerSignal?.addEventListener("abort", abort, { once: true });
  if (input.ownerSignal?.aborted) abort();
  const panel = useRightPanelStore.getState();
  let expectedRevision = panel.getUserActionRevision(ref);
  const closeRevision = panel.closeRevisionByThreadKey[key] ?? 0;
  const stateAtom = environmentCatalog.stateAtom(ref.environmentId);
  const connection = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(stateAtom)));
  const prepared = readPreparedConnection(ref.environmentId);
  const entry = appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.get(ref.environmentId);
  const initialEpoch = readThreadPreviewState(ref).serverEpoch;
  let ownPanelChange = false;
  let selectedTabId: string | undefined;
  let expectedEpoch = initialEpoch;
  const check = () => {
    const current = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(stateAtom)));
    const store = useRightPanelStore.getState();
    const preview = readThreadPreviewState(ref);
    if (
      !connection ||
      connection.phase !== "connected" ||
      !prepared ||
      !entry ||
      !current ||
      current.phase !== "connected" ||
      current.generation !== connection.generation ||
      readPreparedConnection(ref.environmentId) !== prepared ||
      appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(ref.environmentId) !==
        entry ||
      !canOpenLinksInApp(ref) ||
      (!ownPanelChange && store.getUserActionRevision(ref) !== expectedRevision) ||
      (store.closeRevisionByThreadKey[key] ?? 0) !== closeRevision ||
      (preview.serverEpoch !== expectedEpoch && preview.serverEpoch !== null) ||
      (selectedTabId !== undefined &&
        (preview.suppressedTabIds.has(selectedTabId) || !preview.sessions[selectedTabId]))
    )
      abort();
  };
  stops.push(
    appAtomRegistry.subscribe(stateAtom, check),
    appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, check),
    appAtomRegistry.subscribe(
      environmentSession.preparedConnectionValueAtom(ref.environmentId),
      check,
    ),
    appAtomRegistry.subscribe(
      previewEnvironment.openLinkTarget.permissionAtom(ref.environmentId),
      check,
    ),
    appAtomRegistry.subscribe(environmentServerConfigsAtom, check),
    appAtomRegistry.subscribe(previewStateAtom(key), check),
  );
  stops.push(useRightPanelStore.subscribe(check));
  const assertCurrent = () => {
    check();
    if (action.signal.aborted) throw new ThreadLinkCancelled();
  };
  try {
    assertCurrent();
    // Capture ownership before hydration. Revocation or disconnect is sticky
    // even if the same credentials/generation become connected again later.
    const preference = input.explicitApp
      ? "app"
      : await readBrowserSettings(resolveBrowserLinkTargetPreference, action.signal);
    assertCurrent();
    if (targetFor(preference) !== "app") return system;
    const defaults = await readBrowserSettings(resolveBrowserDefaults, action.signal);
    assertCurrent();
    if (targetFor(preference) !== "app") return system;
    const result = await whileCurrent(
      input.allocate({
        environmentId: ref.environmentId,
        input: {
          threadId: ref.threadId,
          profileId: browserDefaultOpenProfileId(defaults),
          viewport: browserDefaultOpenViewport(defaults),
        },
      }),
      action.signal,
    );
    assertCurrent();
    if (result._tag === "Failure") return AsyncResult.failure(result.cause);
    const envelope = result.value;
    const selected = envelope.sessions.find((session) => session.tabId === envelope.selectedTabId);
    if (
      new Set(envelope.sessions.map((session) => session.tabId)).size !==
        envelope.sessions.length ||
      envelope.sessions.some((session) => session.threadId !== ref.threadId) ||
      !selected ||
      selected.purpose !== "thread-link" ||
      selected.runtime !== "server" ||
      selected.automationOwner
    )
      throw new ThreadLinkNavigationError("The server returned an invalid thread-link target.");
    // Reconciliation can ignore an older envelope. Read back the complete index;
    // never revive a selected ID that a newer list removed or a close suppressed.
    expectedEpoch = envelope.serverEpoch;
    reconcilePreviewServerSessions(ref, envelope);
    const current = readThreadPreviewState(ref);
    const target = current.sessions[envelope.selectedTabId];
    if (
      current.serverEpoch !== envelope.serverEpoch ||
      current.serverRevision < envelope.revision ||
      current.suppressedTabIds.has(envelope.selectedTabId) ||
      !target ||
      target.purpose !== "thread-link" ||
      target.runtime !== "server" ||
      target.automationOwner
    )
      throw new ThreadLinkCancelled();
    selectedTabId = target.tabId;
    assertCurrent();
    ownPanelChange = true;
    try {
      useRightPanelStore.getState().openBrowser(ref, target.tabId);
      setActivePreviewTab(ref, target.tabId);
    } finally {
      expectedRevision = useRightPanelStore.getState().getUserActionRevision(ref);
      ownPanelChange = false;
    }
    assertCurrent();
    cancelMaximize = useRightPanelStore.getState().requestMaximize(ref);
    assertCurrent();
    await navigateThreadLink(
      { threadRef: ref, serverEpoch: envelope.serverEpoch, tabId: target.tabId },
      new URL(input.url).href,
      action.signal,
    );
    assertCurrent();
    navigationAccepted = true;
    rememberPreviewUrl(ref, input.url);
    recordVisitForThread(ref, input.url);
    return AsyncResult.success(undefined);
  } catch (error) {
    if (action.signal.aborted || error instanceof ThreadLinkCancelled)
      return AsyncResult.failure(Cause.interrupt());
    if (error instanceof BrowserSettingsReadError || error instanceof ThreadLinkNavigationError)
      return AsyncResult.failure(Cause.fail(error));
    // Unexpected programming/adapter errors retain their rejection semantics.
    throw error;
  } finally {
    if (!navigationAccepted) cancelPendingMaximize();
    action.signal.removeEventListener("abort", cancelPendingMaximize);
    for (const stop of stops) stop();
    input.ownerSignal?.removeEventListener("abort", abort);
    if (actions.get(key) === action) actions.delete(key);
  }
}
