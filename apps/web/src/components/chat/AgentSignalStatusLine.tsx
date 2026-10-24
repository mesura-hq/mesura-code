import type { ThreadAgentSignal } from "@t3tools/contracts";
import { CircleCheckIcon, MessageCircleQuestionIcon } from "lucide-react";

import { Button } from "../ui/button";

/**
 * Mesura: the agent's signal above the composer. It shares `ThreadStatusLine`'s layout but
 * carries two actions and touch-sized buttons, because the phone's web app is where the
 * developer answers it; `ThreadStatusLine` stays upstream's.
 */
export function AgentSignalStatusLine(props: {
  readonly signal: ThreadAgentSignal;
  readonly settleSupported: boolean;
  readonly actionsDisabled: boolean;
  readonly onDismiss: () => void;
  readonly onSettle: () => void;
}) {
  const { signal } = props;
  const needsInput = signal.kind === "needs_input";
  const label = needsInput
    ? signal.note
      ? `Agent needs your input: ${signal.note}`
      : "Agent needs your input"
    : signal.note
      ? `Agent says this thread is ready to close: ${signal.note}`
      : "Agent says this thread is ready to close";
  return (
    <div
      data-chat-thread-status-line="true"
      className="mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center gap-1.5 px-1 pb-2 text-muted-foreground text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {needsInput ? (
        <MessageCircleQuestionIcon aria-hidden className="text-needs-input" />
      ) : (
        <CircleCheckIcon aria-hidden className="text-success" />
      )}
      <span className="line-clamp-2 min-w-0 flex-1">{label}</span>
      {needsInput || !props.settleSupported ? null : (
        <Button variant="ghost" size="xs" disabled={props.actionsDisabled} onClick={props.onSettle}>
          Settle
        </Button>
      )}
      <Button
        variant="ghost-muted"
        size="xs"
        disabled={props.actionsDisabled}
        onClick={props.onDismiss}
      >
        Dismiss
      </Button>
    </div>
  );
}
