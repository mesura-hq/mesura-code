import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useFileManagerStore } from "~/components/files/mesuraFileManager/fileManagerStore";
import { useFileTreeStore } from "~/components/files/mesuraTree/fileTreeStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { newMessageId } from "~/lib/utils";
import { useQuietThreadShell, useQuietThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { toastManager } from "../ui/toast";
import {
  AGENT_SEARCH_FINISHED_TITLE,
  AGENT_SEARCH_TOAST_TIMEOUT_MS,
} from "./agentSearchNotification";
import {
  isSearchThread,
  searchRunOf,
  searchSettled,
  type SearchRun,
} from "./agentSearchPopup.logic";
import {
  closeAgentSearchPopupForWorkspace,
  dispatchAgentSearchPopup,
  takeSearchFirstMessage,
  useAgentSearchPopupStore,
} from "./agentSearchPopupStore";
import { AgentSearchPopup } from "./AgentSearchPopup";
import { ThreadSearchToolRuntime } from "./ThreadSearchToolRuntime";

/**
 * Mesura: everything the agent search needs while the app runs, wherever the
 * sidebar is: the popup, each search's first message, the end of a search,
 * and this tab's search client.
 */
export function AgentSearchHost() {
  const firstMessages = useAgentSearchPopupStore((state) => state.firstMessages);
  return (
    <>
      <AgentSearchPopup />
      <SearchLifecycle />
      <ClosePopupOnNavigation />
      <CloseSearchToastsOnOpen />
      <ClosePopupForWorkspace />
      <ThreadSearchToolRuntime />
      {[...firstMessages.entries()].map(([key, { search }]) => (
        <FirstMessageSender key={key} search={search} />
      ))}
    </>
  );
}

/** Sends the query once its search's shell, which carries the runtime mode, arrives. */
function FirstMessageSender({ search }: { search: ScopedThreadRef }) {
  const shell = useQuietThreadShell(search);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: sends the queued first message once the search's thread shell arrives from the server
  useEffect(() => {
    if (shell === null) return;
    const text = takeSearchFirstMessage(search);
    if (text === null) return;
    void startTurn({
      environmentId: search.environmentId,
      input: {
        threadId: search.threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        titleSeed: text,
        dispatchMode: "queue",
      },
    });
  }, [search, shell, startTurn]);
  return null;
}

interface SearchSnapshot {
  readonly search: ScopedThreadRef;
  readonly title: string;
  readonly run: SearchRun | null;
}

/**
 * Watches the search threads: one that stops working has ended, and one whose
 * shell is gone was deleted. An ended search the popup is not showing is
 * announced with a toast and marked unseen.
 */
function SearchLifecycle() {
  const threads = useQuietThreadShells();
  const previous = useRef<Map<string, SearchSnapshot> | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: diffs server thread shells against the previous render to announce ended searches
  useEffect(() => {
    const next = new Map<string, SearchSnapshot>();
    for (const thread of threads) {
      if (!isSearchThread(thread)) continue;
      const search = scopeThreadRef(thread.environmentId, thread.id);
      next.set(scopedThreadKey(search), {
        search,
        title: thread.title,
        run: searchRunOf(thread),
      });
    }
    const prior = previous.current;
    previous.current = next;
    if (prior === null) return;
    for (const [key, before] of prior) {
      const now = next.get(key);
      if (!now) dispatchAgentSearchPopup({ type: "deleted", search: before.search });
      else if (searchSettled(before.run, now.run)) announceSettled(now);
    }
  }, [threads]);
  return null;
}

/** Finished-search toasts still on screen; the popup closes them when it opens. */
const shownSearchToasts = new Set<string>();

function announceSettled({ search, title }: SearchSnapshot): void {
  dispatchAgentSearchPopup({ type: "settled", search });
  // The open popup lists the result and the sparkle carries its dot; a toast
  // would sit over the popup's history and take its clicks.
  if (useAgentSearchPopupStore.getState().open) return;
  const toastId = toastManager.add({
    type: "success",
    title: AGENT_SEARCH_FINISHED_TITLE,
    description: title,
    timeout: AGENT_SEARCH_TOAST_TIMEOUT_MS,
    data: { hideCopyButton: true },
    actionProps: {
      children: "Open",
      onClick: () => {
        toastManager.close(toastId);
        shownSearchToasts.delete(toastId);
        dispatchAgentSearchPopup({ type: "open", search });
      },
    },
  });
  shownSearchToasts.add(toastId);
}

/** The popup shows every finished search, so their toasts make way for it. */
function CloseSearchToastsOnOpen() {
  const open = useAgentSearchPopupStore((state) => state.open);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: closes search toasts when the popup store opens, from any entry point
  useEffect(() => {
    if (!open) return;
    for (const toastId of shownSearchToasts) toastManager.close(toastId);
    shownSearchToasts.clear();
  }, [open]);
  return null;
}

/** A result link navigates the app; the found thread should not sit behind the popup. */
function ClosePopupOnNavigation() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const shownPathname = useRef(pathname);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: closes the popup when the router's pathname changes
  useEffect(() => {
    if (shownPathname.current === pathname) return;
    shownPathname.current = pathname;
    dispatchAgentSearchPopup({ type: "close" });
  }, [pathname]);
  return null;
}

/**
 * A move into the workspace behind the popup closes it first: opening the file manager, a deferred
 * move to the file tree, or a user action on a right panel. A search has no project to act on,
 * and a surface stacked under the modal popup would take the keyboard where nobody can see it.
 */
function ClosePopupForWorkspace() {
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: subscribes to the file manager, tree and right panel stores for the mount's lifetime
  useEffect(() => {
    const closePopup = closeAgentSearchPopupForWorkspace;
    const offManager = useFileManagerStore.subscribe((state, previous) => {
      if (state.open && !previous.open) closePopup();
    });
    const offTree = useFileTreeStore.subscribe((state, previous) => {
      if (state.pendingFocus && !previous.pendingFocus) closePopup();
    });
    // Every user action on a right panel (a launcher row, a surface tab) counts here.
    const offPanels = useRightPanelStore.subscribe((state, previous) => {
      if (state.userActionRevisionByThreadKey !== previous.userActionRevisionByThreadKey) {
        closePopup();
      }
    });
    return () => {
      offManager();
      offTree();
      offPanels();
    };
  }, []);
  return null;
}
