import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { FactoryTimelineItem } from "@t3tools/client-runtime/factory/plan-activities";
import type {
  FactoryPlanActivityPayload,
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
  ThreadAgentSignal,
} from "@t3tools/contracts";
import {
  CircleCheckIcon,
  ClipboardListIcon,
  FileTextIcon,
  Maximize2Icon,
  MessageCircleQuestionIcon,
  ShieldIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { summarizeFactoryRoutes } from "../../factory/FactoryRoutePicker";
import { useHoldFactoryPlanCardSession } from "../../factory/factoryPlanCardSession";
import { factoryPlanRoutesKey, useFactoryPlanApproval } from "../../factory/useFactoryPlanApproval";
import { useFactoryPlanRoutes } from "../../factory/useFactoryPlanRoutes";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { dispatchQuestionFocus } from "../../lib/pickerActionBus";
import type { PendingApproval } from "../../session-logic";
import { Badge } from "../ui/badge";
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

/** The agent's signal with the thread actions it offers, as `useThreadLifecycle` provides them. */
export interface AgentSignalDockEntry {
  readonly signal: ThreadAgentSignal;
  readonly settleSupported: boolean;
  readonly actionsDisabled: boolean;
  readonly onDismiss: () => void;
  readonly onSettle: () => void;
}

/** What `ChatView` owns and the dock reads: everything else comes from the composer. */
export interface PinnedActionDockSources {
  readonly factoryItems: ReadonlyArray<FactoryTimelineItem>;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  /** The inline question cards' shared state; questions are answered there (ADR-007). */
  readonly pendingUserInput: InlinePendingUserInputContext | null;
  readonly agentSignal: AgentSignalDockEntry | null;
  readonly onOpenFactoryPlan: ((planId: string) => void) | null;
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
 * Mesura: every card that waits on the developer, pinned above the composer input in the slot
 * the composer's top drawer used, so it stays on screen whatever the timeline's scroll position.
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
    factoryPlans: sources.factoryItems.filter((item) => item.kind === "plan"),
    messages: sources.messages,
    planFollowUp: props.planFollowUp,
    agentSignal: sources.agentSignal?.signal ?? null,
    unpins,
  });
  // The pinned plan's routes and send state outlive its body, which collapsing unmounts.
  const pinnedPlan = items.find((item) => item.kind === "plan");
  useHoldFactoryPlanCardSession(
    pinnedPlan ? factoryPlanRoutesKey(threadRef, pinnedPlan.digest) : null,
  );
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
      case "agent-signal":
        return sources.agentSignal?.actionsDisabled ?? true;
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
      case "unpin-plan":
        usePinnedActionDockStore.getState().unpinPlan(threadKey, action.digest);
        return;
      case "dismiss-plan-follow-up":
        usePinnedActionDockStore.getState().dismissFollowUp(threadKey, action.planId);
        return;
      case "clear-agent-signal":
        sources.agentSignal?.onDismiss();
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
                    threadRef={threadRef}
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
    case "plan":
      return <ClipboardListIcon />;
    case "plan-follow-up":
      return <FileTextIcon />;
    case "agent-signal":
      return item.signal.kind === "needs_input" ? (
        <MessageCircleQuestionIcon className="text-needs-input" />
      ) : (
        <CircleCheckIcon className="text-success" />
      );
  }
}

function collapsedTitle(item: PinnedActionDockItem): string {
  switch (item.kind) {
    case "plan":
      return `${item.title} · ${item.phaseCountLabel}`;
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
  readonly threadRef: ScopedThreadRef;
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
    case "plan": {
      const open = dock.sources.onOpenFactoryPlan;
      return (
        <PinnedPlanBody
          threadRef={props.threadRef}
          plan={item.plan}
          title={item.title}
          phaseCountLabel={item.phaseCountLabel}
          onOpen={open ? () => open(item.planId) : null}
          close={close}
        />
      );
    }
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
    case "agent-signal": {
      const entry = dock.sources.agentSignal;
      return (
        <>
          <ComposerBanner.Content>
            <span className="line-clamp-2 min-w-0 flex-1 text-muted-foreground">{item.title}</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {entry && item.signal.kind === "ready_to_close" && entry.settleSupported ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={entry.actionsDisabled}
                onClick={entry.onSettle}
              >
                Settle
              </Button>
            ) : null}
            {close}
          </ComposerBanner.Actions>
        </>
      );
    }
  }
}

/**
 * The compact plan card: title, phase count and routes, with Open and the same Approve as the
 * timeline card, routes included. The full card stays in the timeline as the record.
 */
function PinnedPlanBody(props: {
  readonly threadRef: ScopedThreadRef;
  readonly plan: FactoryPlanActivityPayload;
  readonly title: string;
  readonly phaseCountLabel: string;
  readonly onOpen: (() => void) | null;
  readonly close: ReactNode;
}) {
  const { state, providers, approve, canApprove, sending } = useFactoryPlanApproval(
    props.threadRef,
    props.plan,
  );
  const { routes, violations } = useFactoryPlanRoutes(
    factoryPlanRoutesKey(props.threadRef, props.plan.digest),
    providers,
  );
  return (
    <>
      <ComposerBanner.Content className="flex-col items-start">
        <span className="flex w-full min-w-0 items-center gap-2">
          <Badge variant="secondary">Factory plan</Badge>
          <span className="min-w-0 truncate font-medium text-foreground">{props.title}</span>
          <span className="shrink-0 text-muted-foreground">{props.phaseCountLabel}</span>
        </span>
        <span className="w-full min-w-0 truncate text-muted-foreground">
          {routes === null
            ? "A role has no model yet: open the plan to choose one."
            : summarizeFactoryRoutes(providers, routes)}
        </span>
        {violations[0] ? (
          <span className="text-destructive">{violations[0]}</span>
        ) : state.kind === "changed" ? (
          <span className="text-muted-foreground">Changed since approval</span>
        ) : null}
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        {props.onOpen ? (
          <Button size="xs" variant="outline" onClick={props.onOpen}>
            <Maximize2Icon aria-hidden="true" />
            Open
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={!canApprove || routes === null || sending}
          onClick={() => {
            if (routes !== null) void approve(routes);
          }}
        >
          Approve
        </Button>
        {props.close}
      </ComposerBanner.Actions>
    </>
  );
}
