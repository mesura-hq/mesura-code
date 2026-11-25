import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import { sessionDeniesScope } from "@t3tools/client-runtime/state/session";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import { AuthOrchestrationReadScope, type AuthSessionState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

/**
 * `data` is satisfied by any snapshot, cached included. `live` needs the synchronized detail: a
 * cached snapshot cannot tell that a request closed.
 */
export type ArmedThreadNeed = "data" | "live";
/** `unreadable`: this device's session may not read the thread, so its detail never loads. */
export type ArmedThreadAvailability = "loaded" | "loading" | "gone" | "unreadable";

type ConnectionResult = AsyncResult.AsyncResult<SupervisorConnectionState, unknown>;

/** The connection stopped retrying because the host refused this device's credential. */
function connectionRejected(connection: ConnectionResult): boolean {
  if (!AsyncResult.isSuccess(connection)) return false;
  const { phase, lastFailure } = connection.value;
  return (
    phase === "blocked" &&
    lastFailure?._tag === "ConnectionBlockedError" &&
    (lastFailure.reason === "authentication" || lastFailure.reason === "permission")
  );
}

/**
 * Only deletion and a refusal from the host are final: a failed load retries, and the send stays
 * armed meanwhile. The thread stream does not retry an authorization failure and its error text
 * does not tell one apart, so the session and the connection are asked instead.
 */
export function availabilityOf(
  state: EnvironmentThreadState,
  session: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  connection: ConnectionResult,
  need: ArmedThreadNeed,
): ArmedThreadAvailability {
  if (state.status === "deleted") return "gone";
  const loaded = need === "live" ? state.status === "live" : Option.isSome(state.data);
  if (loaded) return "loaded";
  // A session being replaced still carries the previous answer, and a network failure is not the
  // host saying no. A refused reconnect may never reach a session lookup at all.
  const sessionRefused =
    !session.waiting && sessionDeniesScope(session, AuthOrchestrationReadScope);
  return sessionRefused || connectionRejected(connection) ? "unreadable" : "loading";
}
