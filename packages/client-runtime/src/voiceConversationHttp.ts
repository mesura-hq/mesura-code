import {
  ThreadId,
  type VoiceConversationCreateInput,
  type VoiceTranscriptAppendInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { RemoteEnvironmentAuthorization } from "./authorization/service.ts";
import type { PreparedConnection } from "./connection/model.ts";
import { environmentEndpointUrl } from "./environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "./relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  RemoteEnvironmentAuthFetchError,
  type RemoteEnvironmentRequestError,
} from "./rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  type EnvironmentHttpAuthHeaders,
  type EnvironmentHttpAuthorizedAttempt,
} from "./state/environmentHttpAuth.ts";

type VoiceHttpClient = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiGroupClient<"voice">>
>;

const REQUEST_TIMEOUT_MS = 40_000;
const OWNER_CHANGED_MESSAGE =
  "Voice history was not sent because this connection now belongs to another identity. It stays saved in this browser.";
const CONNECTION_GONE_MESSAGE =
  "Voice history was not sent because this connection is no longer in use. It stays saved in this browser.";

const request = <A, E>(
  prepared: PreparedConnection,
  path: string,
  method: "GET" | "POST",
  execute: (args: {
    client: VoiceHttpClient;
    headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E>,
  owner?: VoiceHistoryOwnerGuard,
) =>
  Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "voice",
      method,
      url: (base) => environmentEndpointUrl(base, path),
      timeoutMs: REQUEST_TIMEOUT_MS,
      request: execute,
      ...(owner ? { authorizeAttempt: owner } : {}),
    });
  });

/** History text was not sent: the connection no longer proves the owner it was saved under. */
export class VoiceHistoryOwnerChangedError extends Data.TaggedError(
  "VoiceHistoryOwnerChangedError",
)<{ readonly message: string }> {}

/** A refused owner is a request that could not be authorized; its cause says why. */
const ownerRefused = (message: string) =>
  new RemoteEnvironmentAuthFetchError({
    message,
    cause: new VoiceHistoryOwnerChangedError({ message }),
  });

export type VoiceHistoryOwnerGuard = (
  attempt: EnvironmentHttpAuthorizedAttempt<VoiceHttpClient>,
) => Effect.Effect<void, RemoteEnvironmentRequestError>;

/**
 * Binds history requests to one verified owner. Before every attempt, including a credential
 * retry, the environment must report `historyOwnerId` for that attempt's own authorization;
 * otherwise nothing is sent. A header credential the server already confirmed for this owner is
 * not asked again, because the server binds it to one identity. A browser cookie is invisible to
 * the client, so cookie requests are confirmed every time, immediately before each request.
 * `isCurrent` ends the guard's lifetime, for example when the view that started a resume closes.
 */
export const createVoiceHistoryOwnerGuard = (input: {
  readonly historyOwnerId: string;
  readonly isCurrent: () => boolean;
}): VoiceHistoryOwnerGuard => {
  let confirmedCredential: string | null = null;
  return (attempt) =>
    Effect.gen(function* () {
      if (!input.isCurrent()) return yield* ownerRefused(CONNECTION_GONE_MESSAGE);
      if (attempt.credentialKey !== null && attempt.credentialKey === confirmedCredential) return;
      const url = environmentEndpointUrl(attempt.httpBaseUrl, "/api/voice/settings");
      const headers = yield* attempt.headersFor("GET", url);
      const settings = yield* executeEnvironmentHttpRequest(
        url,
        REQUEST_TIMEOUT_MS,
        attempt.withCredentials(attempt.client.settings({ headers })),
      );
      if (settings.historyOwnerId !== input.historyOwnerId)
        return yield* ownerRefused(OWNER_CHANGED_MESSAGE);
      if (!input.isCurrent()) return yield* ownerRefused(CONNECTION_GONE_MESSAGE);
      confirmedCredential = attempt.credentialKey;
    });
};

export const voiceConversationSettings = (prepared: PreparedConnection) =>
  request(prepared, "/api/voice/settings", "GET", ({ client, headers }) =>
    client.settings({ headers }),
  );

export const configureVoiceConversation = (prepared: PreparedConnection, apiKey: string) =>
  request(prepared, "/api/voice/settings", "POST", ({ client, headers }) =>
    client.configure({ headers, payload: { apiKey } }),
  );

export const createVoiceConversation = (
  prepared: PreparedConnection,
  payload: VoiceConversationCreateInput,
) =>
  request(prepared, "/api/voice/sessions", "POST", ({ client, headers }) =>
    client.create({ headers, payload }),
  );

export const heartbeatVoiceConversation = (prepared: PreparedConnection, sessionId: string) =>
  request(prepared, "/api/voice/sessions/heartbeat", "POST", ({ client, headers }) =>
    client.heartbeat({ headers, payload: { sessionId } }),
  );

/** Ends the call. `lastSequence` declares its final transcript boundary. */
export const endVoiceConversation = (
  prepared: PreparedConnection,
  sessionId: string,
  lastSequence?: number,
  owner?: VoiceHistoryOwnerGuard,
) =>
  request(
    prepared,
    "/api/voice/sessions/end",
    "POST",
    ({ client, headers }) =>
      client.end({
        headers,
        payload: lastSequence === undefined ? { sessionId } : { sessionId, lastSequence },
      }),
    owner,
  );

// Mesura: voice history. Only call these on environments whose voice settings report a
// history owner; older environments do not have the routes.
export const appendVoiceTranscript = (
  prepared: PreparedConnection,
  payload: VoiceTranscriptAppendInput,
  owner: VoiceHistoryOwnerGuard,
) =>
  request(
    prepared,
    "/api/voice/sessions/transcript",
    "POST",
    ({ client, headers }) => client.appendTranscript({ headers, payload }),
    owner,
  );

/** The call's summary for the requester, or null when the environment does not know the call. */
export const readVoiceCall = (
  prepared: PreparedConnection,
  input: { readonly threadId: string; readonly callId: string },
  owner: VoiceHistoryOwnerGuard,
) =>
  request(
    prepared,
    `/api/voice/threads/${encodeURIComponent(input.threadId)}/calls/${encodeURIComponent(input.callId)}/fragments`,
    "GET",
    ({ client, headers }) =>
      client.listFragments({
        headers,
        params: { threadId: ThreadId.make(input.threadId), callId: input.callId },
        payload: { limit: 1 },
      }),
    owner,
  ).pipe(
    Effect.map((page) => page.call),
    Effect.catchTag("VoiceConversationError", (error) =>
      error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

// Mesura: the saved-history viewer. These only read, so any client with orchestration:read may
// open a finished call, including one another client recorded: they never use the owner guard,
// which authorizes writing pending history, not reading it.
const voiceCallsPath = (threadId: string) =>
  `/api/voice/threads/${encodeURIComponent(threadId)}/calls`;

/** One page of a thread's saved calls, newest first; pass `nextCursor` back for the next page. */
export const listVoiceCalls = (
  prepared: PreparedConnection,
  input: { readonly threadId: string; readonly cursor?: string; readonly limit?: number },
) =>
  request(prepared, voiceCallsPath(input.threadId), "GET", ({ client, headers }) =>
    client.listCalls({
      headers,
      params: { threadId: ThreadId.make(input.threadId) },
      payload: {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
    }),
  );

/** One page of a saved call's transcript after `afterSequence`, with the call's summary. */
export const listVoiceTranscript = (
  prepared: PreparedConnection,
  input: {
    readonly threadId: string;
    readonly callId: string;
    readonly afterSequence?: number;
    readonly limit?: number;
  },
) =>
  request(
    prepared,
    `${voiceCallsPath(input.threadId)}/${encodeURIComponent(input.callId)}/fragments`,
    "GET",
    ({ client, headers }) =>
      client.listFragments({
        headers,
        params: { threadId: ThreadId.make(input.threadId), callId: input.callId },
        payload: {
          ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        },
      }),
  );
