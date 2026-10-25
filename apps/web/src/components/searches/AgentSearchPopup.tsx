import type { ScopedThreadRef } from "@t3tools/contracts";
import { HistoryIcon, SparklesIcon } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { ComposerHandleContext } from "~/composerHandleContext";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { useThreadActions } from "~/hooks/useThreadActions";
import { useThreadShell } from "~/state/entities";
import ChatView from "../ChatView";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";
import { Sheet, SheetPopup } from "../ui/sheet";
import { dispatchAgentSearchPopup, useAgentSearchPopupStore } from "./agentSearchPopupStore";
import { ArchivedResultLinks } from "./ArchivedResultLinks";
import { ConversationLayerContext } from "./conversationShortcutOwner";
import { AgentSearchRunningMark } from "./DotsSpinner";
import { SearchHistoryList } from "./SearchHistoryList";
import { useAgentSearchRunning } from "./useAgentSearchActivity";

/**
 * Mesura: the agent search as a floating conversation
 * (docs/mesura/adr-010-search-chats.md). The search is an ordinary thread, so
 * the popup shows it in the ordinary ChatView; earlier searches sit beside it
 * on desktop and behind a header button on a phone. Closing it stops nothing.
 */
export function AgentSearchPopup() {
  const open = useAgentSearchPopupStore((state) => state.open);
  const activeSearch = useAgentSearchPopupStore((state) => state.activeSearch);
  const isMobile = useIsMobile();
  const [historyOpen, setHistoryOpen] = useState(false);
  const running = useAgentSearchRunning();
  const { confirmAndDeleteThread } = useThreadActions();
  // A state ref: the dialog mounts its content after the render that opens it.
  const [conversation, setConversation] = useState<HTMLDivElement | null>(null);
  const composerSurface = useComposerSurface(conversation);

  const select = (search: ScopedThreadRef) => {
    setHistoryOpen(false);
    dispatchAgentSearchPopup({ type: "select", search });
  };
  // The host clears the popup's state when the deleted thread's shell goes away.
  const remove = (search: ScopedThreadRef) => void confirmAndDeleteThread(search);
  const history = (
    <SearchHistoryList activeSearch={activeSearch} onSelect={select} onDelete={remove} />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dispatchAgentSearchPopup({ type: "close" });
      }}
    >
      <DialogPopup variant="workspace" aria-label="Agent search">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4 pe-12">
          <SparklesIcon aria-hidden className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Agent search</h2>
          {isMobile ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Show earlier searches"
              className="ms-auto"
              onClick={() => setHistoryOpen(true)}
            >
              <HistoryIcon />
            </Button>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1">
          {/*
           * WORKAROUND: ChatView's window controls (terminal, right panel) are
           * `position: fixed` at the window's top right; inside the dialog the
           * popup's transform makes it their containing block, so they would
           * cover the popup header. Its own position variables move them to the
           * conversation's top right instead. Remove once ChatView takes an
           * embedded mode that omits window controls (an upstream ChatView edit).
           */}
          <div
            ref={setConversation}
            data-agent-search-conversation=""
            className="relative flex min-w-0 flex-1 flex-col [--workspace-controls-right:calc(18rem+0.75rem)] [--workspace-controls-top:3rem] max-md:[--workspace-controls-right:0.75rem]"
          >
            {activeSearch ? (
              <SearchConversation search={activeSearch} />
            ) : (
              <p className="m-auto px-6 text-sm text-muted-foreground">
                Type in the sidebar Search and press Tab to start a search.
              </p>
            )}
          </div>
          {isMobile ? null : (
            <aside className="flex w-72 shrink-0 flex-col border-s">{history}</aside>
          )}
        </div>
        {running && composerSurface
          ? createPortal(
              <span className="pointer-events-none absolute end-4 top-2.5 z-30">
                <AgentSearchRunningMark />
              </span>,
              composerSurface,
            )
          : null}
        {isMobile ? (
          <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
            <SheetPopup side="right" layer="dialog" aria-label="Earlier searches panel">
              {history}
            </SheetPopup>
          </Sheet>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** The search's ChatView once its shell has reached this client. */
function SearchConversation({ search }: { search: ScopedThreadRef }) {
  const shell = useThreadShell(search);
  // The palette's composer handle belongs to the main conversation; this one
  // has its own, so neither composer overwrites or clears the other's.
  const composerHandle = useRef<ChatComposerHandle | null>(null);
  if (!shell) {
    return <p className="m-auto text-sm text-muted-foreground">Starting the search…</p>;
  }
  return (
    <ComposerHandleContext value={composerHandle}>
      <ConversationLayerContext value="agent-search">
        <ArchivedResultLinks>
          <ChatView
            key={`${search.environmentId}:${search.threadId}`}
            environmentId={search.environmentId}
            threadId={search.threadId}
            routeKind="server"
            reserveTitleBarControlInset={false}
          />
        </ArchivedResultLinks>
      </ConversationLayerContext>
    </ComposerHandleContext>
  );
}

/**
 * The conversation input's surface inside the popup, where the Dots mark sits
 * at the right while the search runs. ChatView owns that markup and mounts it
 * after the thread loads, so the popup follows the DOM rather than adding a
 * slot to the composer (an upstream file).
 */
function useComposerSurface(container: HTMLDivElement | null): HTMLElement | null {
  return useSyncExternalStore(
    (onChange) => {
      if (container === null) return () => {};
      const observer = new MutationObserver(onChange);
      observer.observe(container, { childList: true, subtree: true });
      return () => observer.disconnect();
    },
    () => container?.querySelector<HTMLElement>('[data-chat-composer-main-surface="true"]') ?? null,
  );
}
