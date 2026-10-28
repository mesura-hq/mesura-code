import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { FileTextIcon, MessageCircleQuestionIcon, ShieldIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { dispatchQuestionFocus } from "../../lib/pickerActionBus";
import type { PendingApproval } from "../../session-logic";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import type { InlinePendingUserInputContext } from "./InlinePendingUserInputCard";
import {
  derivePinnedActionDockItems,
  layoutPinnedActionDock,
  pinnedActionDockCloseAction,
  type PinnedActionDockFollowUp,
  type PinnedActionDockItem,
} from "./pinnedActionDock.logic";
import { usePinnedActionDockStore } from "./pinnedActionDockStore";

/** What `ChatView` owns and the dock reads: everything else comes from the composer. */
export interface PinnedActionDockSources {
  /** The inline question cards' shared state; questions are answered there (ADR-007). */
  readonly pendingUserInput: InlinePendingUserInputContext | null;
}

interface PinnedActionDockProps {
  readonly threadRef: ScopedThreadRef;
  readonly sources: PinnedActionDockSources;
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly respondingRequestIds: ReadonlyArray<RuntimeRequestId>;
  readonly canOperate: boolean;
  readonly onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  readonly planFollowUp: PinnedActionDockFollowUp | null;
}

const EMPTY_REQUESTS: InlinePendingUserInputContext["requests"] = [];

/**
 * Pending approvals, questions and plan follow-ups stay visible above the composer input.
 * Each item closes with an X; `pinnedActionDock.logic.ts` decides what that X does.
 */
export function PinnedActionDock(props: PinnedActionDockProps) {
  const { sources, threadRef } = props;
  const threadKey = scopedThreadKey(threadRef);
  const unpins = usePinnedActionDockStore((state) => state.unpins);
  const phoneWidth = useMediaQuery("max-sm");
  const [tappedKey, setTappedKey] = useState<string | null>(null);
  const questions = sources.pendingUserInput;

  const items = derivePinnedActionDockItems({
    threadKey,
    approvals: props.approvals,
    userInputs: questions?.requests ?? EMPTY_REQUESTS,
    planFollowUp: props.planFollowUp,
    unpins,
  });
  if (items.length === 0) return null;
  const layout = layoutPinnedActionDock(items, {
    phoneWidth,
    expandedKeys: new Set(tappedKey === null ? [] : [tappedKey]),
  });

  const isResponding = (requestId: RuntimeRequestId) =>
    props.respondingRequestIds.includes(requestId) ||
    (questions?.respondingRequestIds.includes(requestId) ?? false);
  const closeDisabled = (item: PinnedActionDockItem) => {
    switch (item.kind) {
      case "approval":
        return !props.canOperate || isResponding(item.approval.requestId);
      case "question":
        return (questions?.unavailable ?? true) || isResponding(item.request.requestId);
      default:
        return false;
    }
  };
  // A failed respond or dismiss reports through the thread error its handler already sets.
  const close = (item: PinnedActionDockItem) => {
    const action = pinnedActionDockCloseAction(item);
    switch (action.type) {
      case "respond-approval":
        void props.onRespondToApproval(action.requestId, action.decision);
        return;
      case "dismiss-question":
        void questions?.onDismiss(action.requestId);
        return;
      case "respond-question":
        void questions?.onDismissWithAnswer(action.requestId, action.answers);
        return;
      case "dismiss-plan-follow-up":
        usePinnedActionDockStore.getState().dismissFollowUp(threadKey, action.planId);
        return;
    }
  };

  const closeButton = (item: PinnedActionDockItem) => (
    <ComposerBanner.Dismiss
      aria-label={item.closeLabel}
      disabled={closeDisabled(item)}
      onClick={() => close(item)}
    />
  );

  return (
    <ComposerBanner.Attachment data-chat-composer-top-drawer="true">
      <ComposerBanner.Root
        variant={items.some((item) => item.kind === "approval") ? "warning" : "default"}
        density="comfortable"
      >
        {/* Scrolls inside itself, so a tall stack never pushes the input off a phone's screen. */}
        <div
          role="region"
          aria-label="Pending actions"
          className="flex max-h-[min(24rem,40dvh)] flex-col gap-1 overflow-y-auto overscroll-contain"
        >
          {layout.map(({ item, expanded }) => (
            <div
              key={item.key}
              data-pinned-action-dock-item={item.kind}
              data-expanded={expanded ? "true" : "false"}
              className="min-w-0"
            >
              {expanded ? (
                <ComposerBanner.Row layout={item.kind === "approval" ? "approval" : "wrap-actions"}>
                  <ComposerBanner.Icon>{itemIcon(item)}</ComposerBanner.Icon>
                  <DockItemBody
                    item={item}
                    dock={props}
                    responding={item.kind === "approval" && isResponding(item.approval.requestId)}
                    close={closeButton(item)}
                  />
                </ComposerBanner.Row>
              ) : (
                <CollapsedDockRow
                  item={item}
                  close={closeButton(item)}
                  onExpand={() => setTappedKey(item.key)}
                />
              )}
            </div>
          ))}
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function itemIcon(item: PinnedActionDockItem): ReactNode {
  switch (item.kind) {
    case "approval":
      return <ShieldIcon />;
    case "question":
      return <MessageCircleQuestionIcon />;
    case "plan-follow-up":
      return <FileTextIcon />;
  }
}

function collapsedTitle(item: PinnedActionDockItem): string {
  switch (item.kind) {
    case "plan-follow-up":
      return item.title ? `Plan ready: ${item.title}` : "Plan ready";
    default:
      return item.title;
  }
}

/** A collapsed item: one line that a tap expands, and its X. */
function CollapsedDockRow(props: {
  readonly item: PinnedActionDockItem;
  readonly close: ReactNode;
  readonly onExpand: () => void;
}) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>{itemIcon(props.item)}</ComposerBanner.Icon>
      <ComposerBanner.Content>
        <button
          type="button"
          data-pinned-action-dock-expand="true"
          aria-expanded={false}
          className="min-h-7 min-w-0 flex-1 truncate rounded-md text-start text-foreground/85 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={props.onExpand}
        >
          {collapsedTitle(props.item)}
        </button>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>{props.close}</ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}

function DockItemBody(props: {
  readonly item: PinnedActionDockItem;
  readonly dock: PinnedActionDockProps;
  readonly responding: boolean;
  readonly close: ReactNode;
}) {
  const { item, dock, close } = props;
  switch (item.kind) {
    case "approval":
      return (
        <>
          <ComposerBanner.Content>
            <ComposerPendingApprovalPanel approval={item.approval} pendingCount={1} />
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerPendingApprovalActions
              requestId={item.approval.requestId}
              disabled={!dock.canOperate}
              isResponding={props.responding}
              options={item.approval.options}
              canRespond={item.approval.responseCapability === "live"}
              onRespondToApproval={dock.onRespondToApproval}
            />
            {close}
          </ComposerBanner.Actions>
        </>
      );
    case "question":
      return (
        <>
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium text-muted-foreground">
              {item.request.questions[0]?.header ?? "Question"}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground/85">{item.title}</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button
              size="xs"
              variant="outline"
              onClick={() => dispatchQuestionFocus(item.request.requestId)}
            >
              Answer
            </Button>
            {close}
          </ComposerBanner.Actions>
        </>
      );
    case "plan-follow-up":
      return (
        <>
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium text-muted-foreground">Plan ready</span>
            {item.title ? (
              <span className="min-w-0 flex-1 truncate text-foreground/85">{item.title}</span>
            ) : null}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>{close}</ComposerBanner.Actions>
        </>
      );
  }
}
