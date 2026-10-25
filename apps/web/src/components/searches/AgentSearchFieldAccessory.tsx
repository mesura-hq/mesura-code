import { SparklesIcon } from "lucide-react";

import { Button } from "../ui/button";
import { shouldShowAgentSearchSparkle } from "./agentSearchPopup.logic";
import { dispatchAgentSearchPopup, useAgentSearchPopupStore } from "./agentSearchPopupStore";
import { AgentSearchRunningMark } from "./DotsSpinner";
import { useAgentSearchRunning } from "./useAgentSearchActivity";
import { useStartSearchChat } from "./useStartSearchChat";

/**
 * Mesura: the right end of the sidebar Search field. The Dots mark while a
 * search runs; otherwise the sparkle, which starts a search with the field's
 * text, or reopens the finished search it marks with a dot.
 */
export function AgentSearchFieldAccessory({ query }: { query: string }) {
  const { start: startSearch, available } = useStartSearchChat();
  const running = useAgentSearchRunning();
  const unseenResult = useAgentSearchPopupStore((state) => state.unseenResult);
  if (running) return <AgentSearchRunningMark />;
  // Without the grant to start one, the sparkle only reopens a finished search.
  if (!shouldShowAgentSearchSparkle({ query: available ? query : "", unseenResult })) return null;
  const unseen = unseenResult !== null;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost-muted"
      aria-label="Search with the agent"
      data-unseen={unseen || undefined}
      onClick={() => {
        if (available && query.trim().length > 0) void startSearch(query);
        else if (unseenResult) dispatchAgentSearchPopup({ type: "open", search: unseenResult });
      }}
    >
      <span className="relative inline-flex">
        <SparklesIcon />
        {unseen ? (
          <span
            aria-hidden
            className="absolute -end-0.5 -top-0.5 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </span>
    </Button>
  );
}
