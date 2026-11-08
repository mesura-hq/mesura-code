import { useAtomValue } from "@effect/atom-react";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import {
  answerThreadSearchToolRequest,
  type AgentThreadSearchEnvironment,
} from "@t3tools/client-runtime/state/agent-thread-search";
import { followStreamInEnvironment, runInEnvironment } from "@t3tools/client-runtime/state/runtime";
import { THREAD_SEARCH_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useLayoutEffect } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironments } from "~/state/environments";
import { serveThreadSearchToolEvents } from "./threadSearchToolHost";

/**
 * The environments a `find_threads` call searches: every one this tab knows,
 * read when a request arrives rather than when the connection opened.
 */
let searchTargets: ReadonlyArray<AgentThreadSearchEnvironment> = [];

/**
 * One search client per environment per tab. `subscribe` follows the
 * environment's sessions, so a reconnect opens a new broker connection, whose
 * `connected` event the host adopts.
 */
const searchClient = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(
      serveThreadSearchToolEvents(
        followStreamInEnvironment(
          environmentId,
          subscribe(THREAD_SEARCH_WS_METHODS.threadSearchToolConnect, {}),
        ),
        {
          answer: ({ description }) =>
            answerThreadSearchToolRequest({
              description,
              environments: searchTargets,
              modelEnvironmentId: environmentId,
            }),
          respond: (response) =>
            runInEnvironment(
              environmentId,
              request(THREAD_SEARCH_WS_METHODS.threadSearchToolRespond, response),
            ),
        },
      ),
    )
    .pipe(Atom.withLabel(`environment-data:thread-search-tool:${environmentId}`)),
);

/** Mesura: this tab answers the search conversations' `find_threads` calls (ADR-010). */
export function ThreadSearchToolRuntime() {
  const { environments } = useEnvironments();
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: publishes the environment list to the module-level search targets after commit
  useLayoutEffect(() => {
    searchTargets = environments.map(({ environmentId, label }) => ({ environmentId, label }));
  }, [environments]);
  return environments
    .filter((environment) => environment.connection.phase === "connected")
    .map(({ environmentId }) => <SearchClient key={environmentId} environmentId={environmentId} />);
}

function SearchClient({ environmentId }: { environmentId: EnvironmentId }) {
  useAtomValue(searchClient(environmentId));
  return null;
}
