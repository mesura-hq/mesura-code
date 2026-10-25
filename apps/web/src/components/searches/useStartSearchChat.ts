import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, THREAD_SEARCH_WS_METHODS, type ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { routeAgentSearchFieldKey } from "./agentSearchPopup.logic";
import {
  dispatchAgentSearchPopup,
  queueSearchFirstMessage,
  useAgentSearchPopupStore,
} from "./agentSearchPopupStore";

const startThreadSearchChat = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-search:start-chat",
  tag: THREAD_SEARCH_WS_METHODS.startThreadSearchChat,
});

// One Tab or sparkle press is one search, however fast the second press comes.
let startInFlight = false;

const noHostPermission = Atom.make(false);

/**
 * Starts a search conversation (docs/mesura/adr-010-search-chats.md) on the
 * primary environment, or the first connected one, and opens the popup on it.
 * The query becomes its first message once the thread reaches this client.
 */
export function useStartSearchChat(): {
  readonly start: (query: string) => Promise<boolean>;
  /** A connected host whose grant lets this client start a search. */
  readonly available: boolean;
} {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const create = useAtomCommand(startThreadSearchChat);
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const host =
    connected.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    connected[0];
  const available = useAtomValue(
    host ? startThreadSearchChat.permissionAtom(host.environmentId) : noHostPermission,
  );

  const start = async (query: string): Promise<boolean> => {
    const text = query.trim();
    if (text.length === 0 || startInFlight) return false;
    if (!host) {
      toastManager.add({
        type: "error",
        title: "Could not start the agent search",
        description: "No host is connected.",
      });
      return false;
    }
    const environmentId = host.environmentId;
    return startSearchConversation(environmentId, text, async () => {
      const result = await create({ environmentId, input: {} });
      return result._tag === "Success" ? result.value.threadId : null;
    });
  };
  return { start, available };
}

/**
 * Starts one search conversation and opens it. Outside the hook: the React Compiler does not
 * compile `try`/`finally` without `catch`, and nothing here needs memoizing.
 */
async function startSearchConversation(
  environmentId: EnvironmentId,
  text: string,
  createThread: () => Promise<ThreadId | null>,
): Promise<boolean> {
  startInFlight = true;
  try {
    const threadId = await createThread();
    if (threadId === null) return false;
    const search = scopeThreadRef(environmentId, threadId);
    queueSearchFirstMessage(search, text);
    dispatchAgentSearchPopup({ type: "open", search });
    return true;
  } finally {
    startInFlight = false;
  }
}

/** The sidebar Search's key handler for the agent search; see `routeAgentSearchFieldKey`. */
export function useAgentSearchFieldKeyDown() {
  const { start, available } = useStartSearchChat();
  return (event: Parameters<typeof routeAgentSearchFieldKey>[0], query: string): boolean =>
    routeAgentSearchFieldKey(event, query, {
      popupOpen: useAgentSearchPopupStore.getState().open,
      start: available ? start : null,
    });
}
