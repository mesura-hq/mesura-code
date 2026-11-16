import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import { ShieldIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { PendingApproval } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import {
  derivePinnedActionDockItems,
  layoutPinnedActionDock,
  pinnedActionDockCloseAction,
  type PinnedActionDockItem,
} from "./pinnedActionDock.logic";

interface PinnedActionDockProps {
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly respondingRequestIds: ReadonlyArray<RuntimeRequestId>;
  readonly canOperate: boolean;
  readonly onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

/**
 * Pending approvals stay visible above the composer input.
 * Each item closes with an X; `pinnedActionDock.logic.ts` decides what that X does.
 */
export function PinnedActionDock(props: PinnedActionDockProps) {
  const phoneWidth = useMediaQuery("max-sm");
  const [tappedKey, setTappedKey] = useState<string | null>(null);

  const items = derivePinnedActionDockItems({ approvals: props.approvals });
  if (items.length === 0) return null;
  const layout = layoutPinnedActionDock(items, {
    phoneWidth,
    expandedKeys: new Set(tappedKey === null ? [] : [tappedKey]),
  });

  const isResponding = (requestId: RuntimeRequestId) =>
    props.respondingRequestIds.includes(requestId);
  const closeDisabled = (item: PinnedActionDockItem) =>
    !props.canOperate || isResponding(item.approval.requestId);
  // A failed respond reports through the thread error its handler already sets.
  const close = (item: PinnedActionDockItem) => {
    const action = pinnedActionDockCloseAction(item);
    void props.onRespondToApproval(action.requestId, action.decision);
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
      <ComposerBanner.Root variant="warning" density="comfortable">
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
                <ComposerBanner.Row layout="approval">
                  <ComposerBanner.Icon>
                    <ShieldIcon />
                  </ComposerBanner.Icon>
                  <DockItemBody
                    item={item}
                    dock={props}
                    responding={isResponding(item.approval.requestId)}
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

/** A collapsed item: one line that a tap expands, and its X. */
function CollapsedDockRow(props: {
  readonly item: PinnedActionDockItem;
  readonly close: ReactNode;
  readonly onExpand: () => void;
}) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        <ShieldIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <button
          type="button"
          data-pinned-action-dock-expand="true"
          aria-expanded={false}
          className="min-h-7 min-w-0 flex-1 truncate rounded-md text-start text-foreground/85 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={props.onExpand}
        >
          {props.item.title}
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
}
