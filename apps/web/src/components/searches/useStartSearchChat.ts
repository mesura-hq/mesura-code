import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { THREAD_SEARCH_WS_METHODS } from "@t3tools/contracts";
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
    startInFlight = true;
    try {
      const result = await create({ environmentId: host.environmentId, input: {} });
      if (result._tag !== "Success") return false;
      const search = scopeThreadRef(host.environmentId, result.value.threadId);
      queueSearchFirstMessage(search, text);
      dispatchAgentSearchPopup({ type: "open", search });
      return true;
    } finally {
      startInFlight = false;
    }
  };
  return { start, available };
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
