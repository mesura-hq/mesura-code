import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import {
  type NotificationTarget,
  notificationTargetPath,
  openNotificationTarget,
} from "../pushNotifications/notificationTarget";
import {
  knownPushRegistration,
  refreshPushRegistration,
  watchPushRegistration,
} from "../pushNotifications/pushRegistration";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import { resolveSidebarThreadAttention } from "./sidebarThreadAttention";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";
import { AGENT_SEARCH_FINISHED_TITLE } from "./searches/agentSearchNotification";
import { isSearchThread } from "./searches/agentSearchPopup.logic";

type LoudKind = "input" | "request" | "approval" | "failed" | "limited";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
  /** Mesura: the sidebar label that asks for the developer, which outranks the status. */
  readonly loudKind: LoudKind | null;
}

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
}

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<
    string,
    { environmentId: EnvironmentId; notification: Notification; persistent?: boolean }
  >();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  const trackNotification = (
    environmentId: EnvironmentId,
    notification: Notification,
    persistent = false,
  ) => {
    const previous = pending.get(notification.tag);
    // Mesura: Chrome gives worker notifications with one tag one ID, so closing the old
    // handle would close the replacement that is already on screen.
    if (!(persistent && previous?.persistent)) previous?.notification.close();
    pending.set(notification.tag, { environmentId, notification, persistent });
    setNotificationBadge(pending.size);
  };
  const navigateToThread = (environmentId: EnvironmentId, threadId: ThreadId) =>
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    setNotificationBadge(0);
  };

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
  ) => {
    const { thread, loudKind } = state;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    // Mesura: a finished agent search has its own title, its own in-app toast
    // (AgentSearchHost) and opens in the search popup.
    const agentSearch = isSearchThread(thread);
    const title =
      kind === "completion"
        ? agentSearch
          ? AGENT_SEARCH_FINISHED_TITLE
          : "Thread completed"
        : loudKind === "approval"
          ? "Approval needed"
          : loudKind === "limited"
            ? "Usage limit reached"
            : loudKind === "failed"
              ? "Thread failed"
              : loudKind === "request"
                ? "Guest request"
                : "Input needed";
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind, () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      !(agentSearch && kind === "completion") &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      const toastId = toastManager.add({
        type: kind === "completion" ? "success" : loudKind === "failed" ? "error" : "warning",
        title,
        description: thread.title,
        data: {
          hideCopyButton: true,
          leadingIcon:
            kind === "completion" ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : loudKind === "approval" ? (
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : loudKind === "failed" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ) : (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
            ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            navigateToThread(environmentId, thread.id);
          },
        },
      });
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    const target: NotificationTarget = { environmentId, threadId: thread.id, agentSearch };
    // Mesura: Android Chrome throws on the Notification constructor, so a page with the push
    // worker shows the notification through it. The worker posts a click back as
    // `mesura-push-open`, which AppRoot opens.
    const registration = knownPushRegistration();
    if (registration) {
      const tag = threadNotificationTag(environmentId, thread.id);
      void registration
        .showNotification(title, {
          body: thread.title,
          tag,
          silent: true,
          data: { url: notificationTargetPath(target) },
        })
        // The shown notification joins the badge count and closes with the others.
        .then(() => registration.getNotifications({ tag }))
        .then((shown) => {
          const notification = shown.at(-1);
          if (notification) trackNotification(environmentId, notification, true);
        })
        // A worker unregistered since the last lookup; the next notification uses what is left.
        .catch(() => void refreshPushRegistration());
      return;
    }
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      trackNotification(environmentId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow?.().catch(() => undefined);
        openNotificationTarget(target, navigateToThread);
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    // A parent here also hears of what its tasks on linked environments ask.
    const subagentRequests = registry.get(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
    );
    const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (
        isShownUnderParent(
          { environmentId, threadId: rawThread.id },
          rawThread.lineage,
          delegatedUnderParent,
        )
      ) {
        continue;
      }
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      // Mesura: the sidebar's label decides, so an agent's needs-input signal or a stopped
      // Factory run asks for the developer the way a structured question does.
      const attentionKind =
        resolveSidebarThreadAttention({
          status,
          isUnread: false,
          isWoke: false,
          agentSignal: thread.agentSignal,
          factoryRun: thread.factoryRun,
          hasOpenPullRequest: false,
        })?.kind ?? null;
      const loudKind: LoudKind | null =
        status === "request"
          ? "request"
          : attentionKind === "input" ||
              attentionKind === "approval" ||
              attentionKind === "failed" ||
              attentionKind === "limited"
            ? attentionKind
            : null;
      const signalSetAt =
        thread.agentSignal?.kind === "needs_input" ? `:${thread.agentSignal.setAt}` : "";
      const attention = loudKind
        ? `${thread.latestRun?.runId ?? ""}:${loudKind}${signalSetAt}`
        : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const settled = status === "ready" && thread.latestRun?.status === "completed";
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        loudKind,
        attention,
        settled,
        completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    entry.previous = next;
    entry.gate.retain(new Set(next.keys()));
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        // Mesura: a completion while the thread still asks for input would replace that
        // notification (both carry the thread's tag), so it is recorded, not announced.
        quiet: state.raw.latestRunStopRequested === true || state.loudKind === "input",
      });
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (state) present(environmentId, state, kind);
      }),
    };
    let latestThreads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        const threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        latestThreads = threads;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads);
          return;
        }
        entry.gate.clear();
        entry.previous = new Map();
      },
      { immediate: true },
    );
    // Mesura: tasks on linked environments change what a thread here asks and whether it lists.
    const reobserve = () => {
      if (latestThreads !== null) observeThreads(environmentId, entry, latestThreads);
    };
    const unsubscribeLinked = [
      registry.subscribe(
        environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
        reobserve,
      ),
      registry.subscribe(environmentThreadShells.delegatedUnderParentAtom, reobserve),
    ];
    entry.unsubscribe = () => {
      unsubscribeShell();
      for (const unsubscribe of unsubscribeLinked) unsubscribe();
      entry.gate.clear();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear?.(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  // Mesura: page notifications show through the push worker when this page has one.
  const stopPushRegistration = watchPushRegistration();
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  onSettings();

  return () => {
    unsubscribeSettings();
    stopPushRegistration();
    unsubscribeEnvironmentIds();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
  };
}
