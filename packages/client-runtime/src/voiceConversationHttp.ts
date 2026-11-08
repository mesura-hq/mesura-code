import type { VoiceConversationCreateInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RemoteEnvironmentAuthorization } from "./authorization/service.ts";
import type { PreparedConnection } from "./connection/model.ts";
import { environmentEndpointUrl } from "./environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "./relay/managedRelay.ts";
import { makeEnvironmentHttpApiGroupClient } from "./rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  type EnvironmentHttpAuthHeaders,
} from "./state/environmentHttpAuth.ts";

type VoiceHttpClient = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiGroupClient<"voice">>
>;

const request = <A, E>(
  prepared: PreparedConnection,
  path: string,
  method: "GET" | "POST",
  execute: (args: {
    client: VoiceHttpClient;
    headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E>,
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
      timeoutMs: 40_000,
      request: execute,
    });
  });

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

export const endVoiceConversation = (prepared: PreparedConnection, sessionId: string) =>
  request(prepared, "/api/voice/sessions/end", "POST", ({ client, headers }) =>
    client.end({ headers, payload: { sessionId } }),
  );
