import type { ThreadAgentSignal } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

export interface ThreadAgentSignalEntry {
  readonly signal: ThreadAgentSignal;
  readonly settleSupported: boolean;
  readonly actionsDisabled: boolean;
  readonly onDismiss: () => void;
  readonly onSettle: () => void;
}

export function ThreadAgentSignalEnd({ entry }: { readonly entry: ThreadAgentSignalEntry }) {
  if (entry.signal.kind === "needs_input") return null;
  const dismiss = (
    <ComposerBanner.Dismiss
      aria-label="Dismiss the agent's signal"
      disabled={entry.actionsDisabled}
      onClick={entry.onDismiss}
    />
  );
  return (
    <div className="chat-content-lane py-2" data-thread-agent-signal={entry.signal.kind}>
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
    </div>
  );
}
