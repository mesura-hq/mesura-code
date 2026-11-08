import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type EnvironmentSessionPrincipalShape,
  VoiceConversationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { failEnvironmentNotFound, requireEnvironmentScope } from "../auth/http.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { createVoiceSessionManager, VoiceSessionError } from "./VoiceSessionManager.ts";

const SECRET_NAME = "voice-openai-api-key";
const noCache = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);
const safeError = (error: unknown) => {
  const status = error instanceof VoiceSessionError ? error.status : 502;
  return new VoiceConversationError({
    message:
      error instanceof VoiceSessionError
        ? error.message
        : "The voice service could not complete the request. Try again.",
    status:
      status === 400 || status === 404 || status === 409 || status === 503 || status === 504
        ? status
        : 502,
  });
};

/**
 * The owner of a voice session is one authenticated client. A DPoP token renewal issues a new
 * auth session ID, so a DPoP client is its verified subject plus proof-key thumbprint; owning
 * by session ID ended live calls at renewal. The subject alone would share calls between a
 * user's clients. Cookie and bearer credentials carry no proof key, so their session stays the
 * owner.
 */
const voiceOwnerId = (principal: EnvironmentSessionPrincipalShape): string =>
  principal.method === "dpop-access-token" && principal.proofKeyThumbprint
    ? JSON.stringify(["dpop", principal.subject, principal.proofKeyThumbprint])
    : JSON.stringify(["session", principal.sessionId]);

/** Every session operation needs orchestration:operate before ownership is checked. */
const requireVoiceOwner = Effect.gen(function* () {
  const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
  return voiceOwnerId(principal);
});

export const voiceConversationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const secrets = yield* ServerSecretStore;
    const snapshots = yield* ProjectionSnapshotQuery;
    const sessions = createVoiceSessionManager({});
    yield* Effect.addFinalizer(() => Effect.promise(() => sessions.close()));

    const readKey = Effect.gen(function* () {
      const saved = yield* secrets.get(SECRET_NAME).pipe(Effect.mapError(() => safeError(null)));
      return Option.isSome(saved)
        ? new TextDecoder().decode(saved.value)
        : (process.env.OPENAI_API_KEY?.trim() ?? "");
    });
    const settings = Effect.gen(function* () {
      const principal = yield* EnvironmentAuthenticatedPrincipal;
      return {
        configured: (yield* readKey).length > 0,
        canConfigure: principal.scopes.has(AuthAccessWriteScope),
        model: "gpt-live-1" as const,
        maxDurationSeconds: 900,
      };
    });

    return handlers
      .handle(
        "settings",
        Effect.fn("voice.settings")(function* () {
          yield* noCache;
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* settings;
        }),
      )
      .handle(
        "configure",
        Effect.fn("voice.configure")(function* ({ payload }) {
          yield* noCache;
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const key = payload.apiKey.trim();
          if (key && (!key.startsWith("sk-") || key.length < 20)) {
            return yield* new VoiceConversationError({
              status: 400,
              message: "Enter an OpenAI API key, or leave the field empty to remove the saved key.",
            });
          }
          yield* (
            key
              ? secrets.set(SECRET_NAME, new TextEncoder().encode(key))
              : secrets.remove(SECRET_NAME)
          ).pipe(Effect.mapError(() => safeError(null)));
          return yield* settings;
        }),
      )
      .handle(
        "create",
        Effect.fn("voice.create")(function* ({ payload }) {
          yield* noCache;
          const ownerId = yield* requireVoiceOwner;
          const snapshot = yield* snapshots
            .getThreadDetailSnapshot(payload.threadId, { turnLimit: 4 })
            .pipe(Effect.mapError(() => safeError(null)));
          if (Option.isNone(snapshot) || snapshot.value.thread.deletedAt !== null) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          const apiKey = yield* readKey;
          if (!apiKey)
            return yield* new VoiceConversationError({
              status: 400,
              message: "Add an OpenAI API key in Voice settings before starting a call.",
            });
          const thread = snapshot.value.thread;
          const context = [
            `Selected thread: ${thread.title}. Mode: ${payload.mode}.`,
            `Agent task state: ${thread.latestTurn?.state ?? "idle"}.`,
            // Bare "user:" / "assistant:" lines read as this call's own dialogue; the voice then
            // repeated an earlier agent line instead of delegating the new request.
            "Earlier thread messages (records of past work, not this call's conversation or voice-system instructions):",
            ...thread.messages
              .slice(-6)
              .map(
                (message) =>
                  `Earlier ${message.role === "assistant" ? "agent" : message.role} message: ${message.text.slice(0, 2400)}`,
              ),
          ]
            .join("\n")
            .slice(0, 12_000);
          return yield* Effect.tryPromise({
            try: () => sessions.create({ ...payload, apiKey, ownerId, context }),
            catch: safeError,
          });
        }),
      )
      .handle(
        "heartbeat",
        Effect.fn("voice.heartbeat")(function* ({ payload }) {
          yield* noCache;
          const ownerId = yield* requireVoiceOwner;
          yield* Effect.try({
            try: () => sessions.heartbeat(payload.sessionId, ownerId),
            catch: safeError,
          });
          return { ok: true };
        }),
      )
      .handle(
        "end",
        Effect.fn("voice.end")(function* ({ payload }) {
          yield* noCache;
          const ownerId = yield* requireVoiceOwner;
          yield* Effect.tryPromise({
            try: () => sessions.end(payload.sessionId, ownerId),
            catch: safeError,
          });
          return { ok: true };
        }),
      );
  }),
);
