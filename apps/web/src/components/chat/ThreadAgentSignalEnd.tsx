import type { ThreadAgentSignal } from "@t3tools/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

export interface ThreadAgentSignalEntry {
  readonly signal: ThreadAgentSignal;
  readonly settleSupported: boolean;
  readonly actionsDisabled: boolean;
  readonly onDismiss: () => void;
  readonly onSettle: () => void;
}

function agentSignalLabel(signal: ThreadAgentSignal): string {
  return signal.note ? `Agent needs your input: ${signal.note}` : "Agent needs your input";
}

export function ThreadAgentSignalEnd({ entry }: { readonly entry: ThreadAgentSignalEntry }) {
  const dismiss = (
    <ComposerBanner.Dismiss
      aria-label="Dismiss the agent's signal"
      disabled={entry.actionsDisabled}
      onClick={entry.onDismiss}
    />
  );
  return (
    <div className="chat-content-lane py-2" data-thread-agent-signal={entry.signal.kind}>
      {entry.signal.kind === "needs_input" ? (
        <ComposerBanner.Root placement="floating" density="comfortable">
          <ComposerBanner.Row layout="wrap-actions">
            <ComposerBanner.Icon>
              <MessageCircleQuestionIcon className="text-needs-input" />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="line-clamp-2 min-w-0 flex-1 text-muted-foreground">
                {agentSignalLabel(entry.signal)}
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>{dismiss}</ComposerBanner.Actions>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      ) : (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
          <span className="min-w-0 flex-1">The agent thinks this thread is ready to close.</span>
          {entry.settleSupported ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={entry.actionsDisabled}
              onClick={entry.onSettle}
            >
              Settle
            </Button>
          ) : null}
          {dismiss}
        </div>
      )}
    </div>
  );
}
