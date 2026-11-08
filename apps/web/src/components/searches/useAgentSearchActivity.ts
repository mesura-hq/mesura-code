import { useQuietThreadShells } from "~/state/entities";
import { isSearchRunning, isSearchThread } from "./agentSearchPopup.logic";
import { useAgentSearchPopupStore } from "./agentSearchPopupStore";

/**
 * Whether an agent search is under way: a search thread working, or a query
 * still waiting to become its search's first message. Quiet shells, because
 * only a status change matters here, not each streamed token.
 */
export function useAgentSearchRunning(): boolean {
  const threads = useQuietThreadShells();
  const waitingFirstMessage = useAgentSearchPopupStore((state) => state.firstMessages.size > 0);
  return (
    waitingFirstMessage ||
    threads.some((thread) => isSearchThread(thread) && isSearchRunning(thread))
  );
}
