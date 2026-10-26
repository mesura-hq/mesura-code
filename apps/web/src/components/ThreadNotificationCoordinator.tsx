import {
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { useDelegatedUnderParent } from "../state/entities";
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
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { resolveSidebarThreadAttention } from "./sidebarThreadAttention";
import { toastManager } from "./ui/toast";
import { AGENT_SEARCH_FINISHED_TITLE } from "./searches/agentSearchNotification";
import { isSearchThread } from "./searches/agentSearchPopup.logic";

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<
      string,
      { environmentId: EnvironmentId; notification: Notification; persistent?: boolean }
    >(),
  );
  const onNotification = (
    environmentId: EnvironmentId,
    notification: Notification,
    persistent = false,
  ) => {
    const previous = pending.current.get(notification.tag);
    // Mesura: Chrome gives worker notifications with one tag one ID, so closing the old
    // handle would close the replacement that is already on screen.
    if (!(persistent && previous?.persistent)) previous?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification, persistent });
    setNotificationBadge(pending.current.size);
  };

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, entry] of pending.current) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  // Mesura: page notifications show through the push worker when this page has one.
  useEffect(() => watchPushRegistration(), []);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
}

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly attention: string | null;
  readonly completion: number | null;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (
    environmentId: EnvironmentId,
    notification: Notification,
    persistent?: boolean,
  ) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  // A parent here also hears of what its tasks on linked environments ask.
  const subagentRequests = useAtomValue(
    environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
  );
  const delegatedUnderParent = useDelegatedUnderParent();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(new Map<ThreadId, NotificationState>());

  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
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
      const prior = previous.current.get(rawThread.id);
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
      const loudKind =
        attentionKind === "input" ||
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
      const completion =
        status === "ready" &&
        thread.latestRun?.status === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { raw: rawThread, subagentRequest, attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : // A completion while the thread still asks for the developer would replace the
            // input notification (both carry the thread's tag); it is recorded, not announced.
            loudKind !== "input" &&
              !rawThread.latestRunStopRequested &&
              completion !== null &&
              (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
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
        (activeEnvironmentId !== environmentId || activeThreadId !== thread.id)
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
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: thread.id },
              });
            },
          },
        });
        continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        continue;
      const target: NotificationTarget = { environmentId, threadId: thread.id, agentSearch };
      // Mesura: Android Chrome throws on the Notification constructor, so a page with the push
      // worker shows the notification through it. Its click reaches the worker, which focuses
      // this window and posts the target back as `mesura-push-open` (AppRoot opens it).
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
            if (notification) onNotification(environmentId, notification, true);
          })
          // A worker unregistered since the last lookup; the next notification uses what is left.
          .catch(() => void refreshPushRegistration());
        continue;
      }
      try {
        const notification = new Notification(title, {
          body: thread.title,
          tag: threadNotificationTag(environmentId, thread.id),
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void window.desktopBridge?.revealWindow?.().catch(() => undefined);
          openNotificationTarget(target, (targetEnvironmentId, threadId) => {
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: targetEnvironmentId, threadId },
            });
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    delegatedUnderParent,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    navigate,
    onNotification,
    subagentRequests,
    threads,
  ]);

  return null;
}
