import type { ScopedThreadRef } from "@t3tools/contracts";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

export interface ThreadLinkTarget {
  readonly threadRef: ScopedThreadRef;
  readonly serverEpoch: string;
  readonly tabId: string;
}

export type NavigationObservation = "loading" | "failed";
export interface ThreadLinkTransport {
  readonly connectionGeneration?: () => number;
  readonly readiness: () => "waiting" | "ready" | "refused";
  readonly navigate: (url: string) => boolean | Promise<boolean>;
  readonly observe: (listener: (status: NavigationObservation) => void) => () => void;
}

export class ThreadLinkCancelled extends Error {}
export class ThreadLinkNavigationError extends Error {}

// These are mounted transport leases, not client-side tab allocation or URL queues.
const transports = new Map<string, ThreadLinkTransport>();
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};
let mountPublicationPending = false;
const publishMountChange = () => {
  if (mountPublicationPending) return;
  mountPublicationPending = true;
  queueMicrotask(() => {
    mountPublicationPending = false;
    publish();
  });
};
const keyFor = (target: ThreadLinkTarget) =>
  previewRuntimeTabId(target.threadRef, target.serverEpoch, target.tabId);

export function registerThreadLinkTransport(
  target: ThreadLinkTarget,
  transport: ThreadLinkTransport,
): () => void {
  const key = keyFor(target);
  transports.set(key, transport);
  // StrictMode replays setup/cleanup/setup before the surface can become ready.
  // Publish the settled mount so a first link does not bind the discarded lease.
  // Control and disconnect notifications remain synchronous and sticky.
  publishMountChange();
  return () => {
    if (transports.get(key) !== transport) return;
    transports.delete(key);
    publishMountChange();
  };
}

export const notifyThreadLinkTransport = publish;

/** Accept only a fresh Loading observation from the exact mounted transport.
 * The protocol has no causal request ID; this is a local acceptance milestone,
 * not attribution of competing cross-client navigations or successful page load.
 */
export function navigateThreadLink(
  target: ThreadLinkTarget,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let selected: ThreadLinkTransport | undefined;
    let connectionGeneration: number | undefined;
    let stopObservation: (() => void) | undefined;
    let submitted = false;
    let finished = false;
    let loadingObserved = false;
    let submissionAccepted = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      listeners.delete(check);
      stopObservation?.();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish(new ThreadLinkCancelled("The link action was cancelled."));
    const check = () => {
      if (signal.aborted) return cancel();
      const current = transports.get(keyFor(target));
      if (selected && current !== selected)
        return finish(new ThreadLinkCancelled("The mounted browser changed."));
      if (!current) return;
      if (selected && current.connectionGeneration?.() !== connectionGeneration)
        return finish(new ThreadLinkCancelled("The browser disconnected."));
      if (!selected) connectionGeneration = current.connectionGeneration?.();
      selected = current;
      const readiness = current.readiness();
      if (readiness === "refused")
        return finish(
          submitted
            ? new ThreadLinkCancelled("Browser control changed.")
            : new ThreadLinkNavigationError("This viewer does not control the browser."),
        );
      if (readiness !== "ready") {
        if (submitted) finish(new ThreadLinkCancelled("The browser disconnected."));
        return;
      }
      if (submitted) return;
      selected = current;
      stopObservation = current.observe((status) => {
        if (!submitted || signal.aborted) return;
        if (transports.get(keyFor(target)) !== selected) return cancel();
        if (current.connectionGeneration?.() !== connectionGeneration) return cancel();
        if (current.readiness() !== "ready") return cancel();
        if (status === "failed")
          return finish(new ThreadLinkNavigationError("The browser rejected navigation."));
        loadingObserved = true;
        if (submissionAccepted) finish();
      });
      submitted = true;
      // Subscription precedes submission: native Loading can arrive synchronously.
      try {
        Promise.resolve(current.navigate(url)).then(
          (accepted) => {
            if (!accepted) return finish(new ThreadLinkNavigationError("Navigation was refused."));
            submissionAccepted = true;
            if (loadingObserved) finish();
          },
          (error: unknown) =>
            finish(new ThreadLinkNavigationError("Browser navigation failed.", { cause: error })),
        );
      } catch (error) {
        finish(new ThreadLinkNavigationError("Browser navigation failed.", { cause: error }));
      }
    };
    // Same bound as the existing preview-tab waiter. An off-route target waits
    // for its own viewer without changing routes or using an unrelated viewer.
    const timer = setTimeout(
      () => finish(new ThreadLinkNavigationError("The browser did not become ready.")),
      5_000,
    );
    signal.addEventListener("abort", cancel, { once: true });
    listeners.add(check);
    check();
  });
}
