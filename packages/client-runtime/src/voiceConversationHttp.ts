import {
  ThreadId,
  type VoiceConversationCreateInput,
  type VoiceTranscriptAppendInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { RemoteEnvironmentAuthorization } from "./authorization/service.ts";
import type { PreparedConnection } from "./connection/model.ts";
import { ManagedRelayDpopSigner } from "./relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
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
/** The voice group's contract URL builder. It encodes params like the client, so DPoP proofs match. */
type VoiceHttpUrls = ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>["voice"];

const REQUEST_TIMEOUT_MS = 40_000;
const OWNER_CHANGED_MESSAGE =
  "Voice history was not sent because this connection now belongs to another identity. It stays saved in this browser.";
const CONNECTION_GONE_MESSAGE =
  "Voice history was not sent because this connection is no longer in use. It stays saved in this browser.";

const request = Effect.fn("clientRuntime.voice.request")(function* <A, E>(
  prepared: PreparedConnection,
  url: (urls: VoiceHttpUrls) => string,
  method: "GET" | "POST",
  execute: (args: {
    client: VoiceHttpClient;
    headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E>,
  owner?: VoiceHistoryOwnerGuard,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    group: "voice",
    method,
    url,
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
 * Before every attempt, including a credential retry, the environment must report `historyOwnerId`
 * for that attempt's authorization, or nothing is sent. A confirmed header credential is not asked
 * again (the server binds it to one identity); an invisible cookie is confirmed before each
 * request. `isCurrent` ends the guard, for example when the resuming view closes.
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
      const url = makeEnvironmentHttpApiUrlBuilder(attempt.httpBaseUrl).voice.settings();
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
  request(
    prepared,
    (urls) => urls.settings(),
    "GET",
    ({ client, headers }) => client.settings({ headers }),
  );

export const configureVoiceConversation = (prepared: PreparedConnection, apiKey: string) =>
  request(
    prepared,
    (urls) => urls.configure(),
    "POST",
    ({ client, headers }) => client.configure({ headers, payload: { apiKey } }),
  );

export const createVoiceConversation = (
  prepared: PreparedConnection,
  payload: VoiceConversationCreateInput,
) =>
  request(
    prepared,
    (urls) => urls.create(),
    "POST",
    ({ client, headers }) => client.create({ headers, payload }),
  );

export const heartbeatVoiceConversation = (prepared: PreparedConnection, sessionId: string) =>
  request(
    prepared,
    (urls) => urls.heartbeat(),
    "POST",
    ({ client, headers }) => client.heartbeat({ headers, payload: { sessionId } }),
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
    (urls) => urls.end(),
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
    (urls) => urls.appendTranscript(),
    "POST",
    ({ client, headers }) => client.appendTranscript({ headers, payload }),
    owner,
  );

/** The call's summary for the requester, or null when the environment does not know the call. */
export const readVoiceCall = (
  prepared: PreparedConnection,
  input: { readonly threadId: string; readonly callId: string },
  owner: VoiceHistoryOwnerGuard,
) => {
  const endpoint = {
    params: { threadId: ThreadId.make(input.threadId), callId: input.callId },
    query: { limit: 1 },
  };
  return request(
    prepared,
    (urls) => urls.listFragments(endpoint),
    "GET",
    ({ client, headers }) => client.listFragments({ ...endpoint, headers }),
    owner,
  ).pipe(
    Effect.map((page) => page.call),
    Effect.catchTags({
      VoiceConversationError: (error) =>
        error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
};

// Mesura: the saved-history viewer. These only read, so any client with orchestration:read may
// open a finished call, including one another client recorded: they never use the owner guard,
// which authorizes writing pending history, not reading it.
/** One page of a thread's saved calls, newest first; pass `nextCursor` back for the next page. */
export const listVoiceCalls = (
  prepared: PreparedConnection,
  input: { readonly threadId: string; readonly cursor?: string; readonly limit?: number },
) => {
  const endpoint = {
    params: { threadId: ThreadId.make(input.threadId) },
    query: {
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
  };
  return request(
    prepared,
    (urls) => urls.listCalls(endpoint),
    "GET",
    ({ client, headers }) => client.listCalls({ ...endpoint, headers }),
  );
};

/** One page of a saved call's transcript after `afterSequence`, with the call's summary. */
export const listVoiceTranscript = (
  prepared: PreparedConnection,
  input: {
    readonly threadId: string;
    readonly callId: string;
    readonly afterSequence?: number;
    readonly limit?: number;
  },
) => {
  const endpoint = {
    params: { threadId: ThreadId.make(input.threadId), callId: input.callId },
    query: {
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
  };
  return request(
    prepared,
    (urls) => urls.listFragments(endpoint),
    "GET",
    ({ client, headers }) => client.listFragments({ ...endpoint, headers }),
  );
};
