import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { openAgentSearch } from "../components/searches/agentSearchNotification";
import type { AppRouter } from "../router";
import { listenForPushOpen, threadRoutePath } from "./pushRegistration";

/**
 * Mesura: where a tapped thread notification leads, for both the page
 * notification's own click and the push worker's `mesura-push-open` message.
 * An agent search opens in its popup, which also handles archived results,
 * rather than on the thread route.
 */
export interface NotificationTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentSearch: boolean;
}

const AGENT_SEARCH_PARAM = "open";
const AGENT_SEARCH_VALUE = "agent-search";

/** The URL path a worker notification carries: the thread route, marked for a search. */
export function notificationTargetPath(target: NotificationTarget): string {
  const path = threadRoutePath(target.environmentId, target.threadId);
  return target.agentSearch ? `${path}?${AGENT_SEARCH_PARAM}=${AGENT_SEARCH_VALUE}` : path;
}

/** The target a thread route path names, or null for any other path. */
export function parseNotificationTargetPath(path: string): NotificationTarget | null {
  const url = new URL(path, "https://notification-target.invalid");
  const segments = url.pathname.split("/").slice(1);
  if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) return null;
  try {
    const [environmentId, threadId] = segments.map((segment) => decodeURIComponent(segment));
    return {
      environmentId: EnvironmentId.make(environmentId!),
      threadId: ThreadId.make(threadId!),
      agentSearch: url.searchParams.get(AGENT_SEARCH_PARAM) === AGENT_SEARCH_VALUE,
    };
  } catch {
    return null;
  }
}

export function openNotificationTarget(
  target: NotificationTarget,
  navigateToThread: (environmentId: EnvironmentId, threadId: ThreadId) => void,
): void {
  if (target.agentSearch) {
    openAgentSearch(scopeThreadRef(target.environmentId, target.threadId));
    return;
  }
  navigateToThread(target.environmentId, target.threadId);
}

/** Opens what the push worker asks this window to open; returns the cleanup. */
export function openPushTargets(router: AppRouter): () => void {
  const navigateToThread = (environmentId: EnvironmentId, threadId: ThreadId) =>
    void router.navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  // A tap with no window open loads the target's URL; its route is already the
  // thread, so only a search still needs its popup.
  const initial = parseNotificationTargetPath(router.state.location.href);
  if (initial?.agentSearch) openNotificationTarget(initial, navigateToThread);
  return listenForPushOpen((path) => {
    const target = parseNotificationTargetPath(path);
    if (target === null) void router.navigate({ href: path });
    else openNotificationTarget(target, navigateToThread);
  });
}
