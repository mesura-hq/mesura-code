import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
  type OrchestrationThreadDetailSnapshot,
  type EnvironmentSessionPrincipalShape,
  VoiceConversationError,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { voiceConversationHttpApiLayer } from "./http.ts";
import { VoiceHistory, type VoiceHistoryShape } from "./VoiceHistory.ts";
import { makeVoiceTestAuthLayer } from "./voiceHttp.testFixtures.ts";

const THREAD_ID = "thread-under-test";
const API_KEY = `sk-${"test-key-".repeat(4)}`;
const SESSION_ID = "client-session-0001";

class VoiceTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.voice) {}

const scopesByToken: Readonly<Record<string, ReadonlyArray<AuthEnvironmentScope>>> = {
  read: [AuthOrchestrationReadScope],
  configure: [AuthAccessWriteScope],
  "admin-read": [AuthOrchestrationReadScope, AuthAccessReadScope],
  operate: [AuthOrchestrationOperateScope],
  "operate-other": [AuthOrchestrationOperateScope],
};

// Principals the real auth middleware would produce after verifying each credential. DPoP
// renewal issues a new auth session ID for the same subject and verified proof key.
const dpopPrincipal = (
  token: string,
  subject: string,
  proofKeyThumbprint: string,
  scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationOperateScope],
): EnvironmentSessionPrincipalShape => ({
  sessionId: `session-${token}` as EnvironmentSessionPrincipalShape["sessionId"],
  subject,
  method: "dpop-access-token",
  scopes: new Set(scopes),
  proofKeyThumbprint,
});
const principalsByToken: Readonly<Record<string, EnvironmentSessionPrincipalShape>> = {
  "dpop-key-a": dpopPrincipal("dpop-key-a", "voice-client", "thumbprint-a"),
  "dpop-key-a-renewed": dpopPrincipal("dpop-key-a-renewed", "voice-client", "thumbprint-a"),
  "dpop-key-a-read-only": dpopPrincipal("dpop-key-a-read-only", "voice-client", "thumbprint-a", [
    AuthOrchestrationReadScope,
  ]),
  "dpop-key-b": dpopPrincipal("dpop-key-b", "voice-client", "thumbprint-b"),
  "dpop-other-subject": dpopPrincipal("dpop-other-subject", "other-client", "thumbprint-a"),
  "bearer-same-subject": {
    sessionId: "session-bearer-same-subject" as EnvironmentSessionPrincipalShape["sessionId"],
    subject: "voice-client",
    method: "bearer-access-token",
    scopes: new Set([AuthOrchestrationOperateScope]),
  },
  "cookie-same-subject": {
    sessionId: "session-cookie-same-subject" as EnvironmentSessionPrincipalShape["sessionId"],
    subject: "voice-client",
    method: "browser-session-cookie",
    scopes: new Set([AuthOrchestrationOperateScope]),
  },
  "cookie-same-subject-other-session": {
    sessionId: "session-cookie-other" as EnvironmentSessionPrincipalShape["sessionId"],
    subject: "voice-client",
    method: "browser-session-cookie",
    scopes: new Set([AuthOrchestrationOperateScope]),
  },
};

const authLayer = makeVoiceTestAuthLayer(
  (token) =>
    principalsByToken[token] ?? {
      sessionId: `session-${token}` as EnvironmentSessionPrincipalShape["sessionId"],
      subject: "voice-http-test",
      method: "bearer-access-token",
      scopes: new Set(scopesByToken[token] ?? []),
    },
);

const makeThreadSnapshot = (deletedAt: string | null = null) =>
  ({
    snapshotSequence: 1,
    thread: {
      id: THREAD_ID,
      title: "Voice test thread",
      latestTurn: { state: "idle" },
      deletedAt,
      messages: [{ role: "user", text: "Explain this function." }],
    },
  }) as unknown as OrchestrationThreadDetailSnapshot;

// Accepts every call start and end, so ownership here is the live session manager's. A test
// overrides one operation to exercise a history failure.
const acceptingVoiceHistory: VoiceHistoryShape = {
  assertCanStart: () => Effect.void,
  start: () => Effect.void,
  end: () => Effect.void,
  endByServer: () => Effect.void,
  retryPendingServerEnds: Effect.void,
  append: () => Effect.die("Not used by voice session HTTP tests."),
  listCalls: () => Effect.die("Not used by voice session HTTP tests."),
  listFragments: () => Effect.die("Not used by voice session HTTP tests."),
};

interface HarnessOptions {
  readonly history?: Partial<VoiceHistoryShape>;
  readonly initialApiKey?: string;
  readonly threadSnapshot?: () => Option.Option<OrchestrationThreadDetailSnapshot>;
  readonly fetch?: typeof fetch;
}

const withHandler = <A>(
  options: HarnessOptions,
  run: (handler: ReturnType<typeof HttpRouter.toWebHandler>) => Promise<A>,
) => {
  const secretsByName = new Map<string, Uint8Array>();
  if (options.initialApiKey) {
    secretsByName.set("voice-openai-api-key", new TextEncoder().encode(options.initialApiKey));
  }

  const secretStoreLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => {
      const value = secretsByName.get(name);
      return Effect.succeed(value ? Option.some(value) : Option.none());
    },
    set: (name, value) => Effect.sync(() => void secretsByName.set(name, value)),
    create: (name, value) => Effect.sync(() => void secretsByName.set(name, value)),
    getOrCreateRandom: () => Effect.die("Not used by voice HTTP tests."),
    remove: (name) => Effect.sync(() => void secretsByName.delete(name)),
  } satisfies ServerSecretStore.ServerSecretStore["Service"]);
  const snapshotQueryLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getThreadDetailSnapshot: () =>
      Effect.succeed(options.threadSnapshot?.() ?? Option.some(makeThreadSnapshot())),
  } as unknown as ProjectionSnapshotQuery["Service"]);
  const routesLayer = HttpApiBuilder.layer(VoiceTestApi).pipe(
    Layer.provide(voiceConversationHttpApiLayer),
    // These routes test the live session; persisted history has its own suite.
    Layer.provide(Layer.succeed(VoiceHistory, { ...acceptingVoiceHistory, ...options.history })),
    Layer.provide(authLayer),
    Layer.provide(secretStoreLayer),
    Layer.provide(snapshotQueryLayer),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

  vi.stubGlobal("fetch", options.fetch ?? fetch);
  const handler = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  return Effect.acquireUseRelease(
    Effect.succeed(handler),
    (environment) => Effect.tryPromise(() => run(environment)),
    (environment) =>
      Effect.promise(() => environment.dispose()).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
          }),
        ),
      ),
  );
};

const get = (path: string, token: string) =>
  new Request(`http://127.0.0.1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

const post = (path: string, body: unknown, token: string) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const call = (environment: ReturnType<typeof HttpRouter.toWebHandler>, request: Request) =>
  environment.handler(request, Context.empty() as Context.Context<unknown>);

const createPayload = {
  sessionId: SESSION_ID,
  threadId: THREAD_ID,
  sdp: "v=0\r\no=test",
  voice: "cedar",
  language: "en",
  mode: "discuss",
};

describe("voice conversation HTTP routes", () => {
  it.effect("returns configuration state without returning the saved key or caching it", () =>
    withHandler({ initialApiKey: API_KEY }, async (environment) => {
      const response = await call(environment, get("/api/voice/settings", "read"));
      if (response.status !== 200) throw new Error(await response.clone().text());
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        configured: true,
        canConfigure: false,
        model: "gpt-live-1",
        maxDurationSeconds: 900,
      });
      expect(body).not.toContain(API_KEY);
    }),
  );

  it.effect("uses the environment key as a fallback without exposing it", () =>
    withHandler({}, async (environment) => {
      vi.stubEnv("OPENAI_API_KEY", API_KEY);
      const response = await call(environment, get("/api/voice/settings", "read"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        configured: true,
        canConfigure: false,
        model: "gpt-live-1",
        maxDurationSeconds: 900,
      });
      expect(body).not.toContain(API_KEY);
    }),
  );

  it.effect("allows only access:write to configure the key and never returns it", () =>
    withHandler({}, async (environment) => {
      const forbidden = await call(
        environment,
        post("/api/voice/settings", { apiKey: API_KEY }, "operate"),
      );
      expect(forbidden.status).toBe(403);

      const readOnlyState = await call(environment, get("/api/voice/settings", "admin-read"));
      expect(readOnlyState.status).toBe(200);
      expect(JSON.parse(await readOnlyState.text())).toMatchObject({ canConfigure: false });
      const readOnlyConfigure = await call(
        environment,
        post("/api/voice/settings", { apiKey: API_KEY }, "admin-read"),
      );
      expect(readOnlyConfigure.status).toBe(403);

      const configured = await call(
        environment,
        post("/api/voice/settings", { apiKey: API_KEY }, "configure"),
      );
      expect(configured.status).toBe(200);
      expect(configured.headers.get("cache-control")).toBe("no-store");
      const body = await configured.text();
      expect(body).not.toContain(API_KEY);
      expect(JSON.parse(body)).toEqual({
        configured: true,
        canConfigure: true,
        model: "gpt-live-1",
        maxDurationSeconds: 900,
      });
    }),
  );

  it.effect(
    "requires orchestration:operate and rejects missing or deleted threads before provider access",
    () => {
      let threadSnapshot = Option.none<OrchestrationThreadDetailSnapshot>();
      const providerFetch = vi.fn<typeof fetch>();
      return withHandler(
        {
          initialApiKey: API_KEY,
          threadSnapshot: () => threadSnapshot,
          fetch: providerFetch,
        },
        async (environment) => {
          const insufficientScope = await call(
            environment,
            post("/api/voice/sessions", createPayload, "read"),
          );
          expect(insufficientScope.status).toBe(403);

          const missingThread = await call(
            environment,
            post("/api/voice/sessions", createPayload, "operate"),
          );
          expect(missingThread.status).toBe(404);

          threadSnapshot = Option.some(makeThreadSnapshot("2026-10-05T00:00:00.000Z"));
          const deletedThread = await call(
            environment,
            post("/api/voice/sessions", createPayload, "operate"),
          );
          expect(deletedThread.status).toBe(404);
          expect(providerFetch).not.toHaveBeenCalled();
        },
      );
    },
  );

  it.effect("creates an authenticated session without returning the provider key", () => {
    const providerFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            session: { id: "provider-session" },
            transport: { sdp: "v=0\r\nanswer" },
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    return withHandler({ initialApiKey: API_KEY, fetch: providerFetch }, async (environment) => {
      const response = await call(
        environment,
        post("/api/voice/sessions", createPayload, "operate"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ sessionId: SESSION_ID, sdp: "v=0\r\nanswer" });
      expect(body).not.toContain(API_KEY);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      const request = providerFetch.mock.calls[0];
      expect(new Headers(request?.[1]?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
    });
  });

  it.effect("sanitizes provider create failures", () => {
    const providerFetch = vi.fn<typeof fetch>(
      async () => new Response("provider-secret-detail", { status: 500 }),
    );
    return withHandler({ initialApiKey: API_KEY, fetch: providerFetch }, async (environment) => {
      const response = await call(
        environment,
        post("/api/voice/sessions", createPayload, "operate"),
      );
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("The voice service could not create a session.");
      expect(body).not.toContain("provider-secret-detail");
      expect(body).not.toContain(API_KEY);
    });
  });

  it.effect(
    "keeps a DPoP voice session across token renewal and isolates other keys, subjects and sessions",
    () => {
      const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
        if (
          init?.method === "POST" &&
          String(input) === "https://api.openai.com/v1/live/sessions"
        ) {
          return new Response(
            JSON.stringify({
              session: { id: "provider-session" },
              transport: { sdp: "v=0\\r\\nanswer" },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(null, { status: 204 });
      });
      return withHandler({ initialApiKey: API_KEY, fetch: providerFetch }, async (environment) => {
        const heartbeat = (token: string) =>
          call(
            environment,
            post("/api/voice/sessions/heartbeat", { sessionId: SESSION_ID }, token),
          );
        const end = (token: string) =>
          call(environment, post("/api/voice/sessions/end", { sessionId: SESSION_ID }, token));

        const created = await call(
          environment,
          post("/api/voice/sessions", createPayload, "dpop-key-a"),
        );
        expect(created.status).toBe(200);

        // The renewed token is the same client: same subject and verified proof key.
        expect((await heartbeat("dpop-key-a-renewed")).status).toBe(200);

        // A different proof key, a different subject, and non-DPoP sessions of the same
        // subject are other clients.
        for (const token of [
          "dpop-key-b",
          "dpop-other-subject",
          "bearer-same-subject",
          "cookie-same-subject",
        ]) {
          const response = await heartbeat(token);
          expect(response.status).toBe(404);
          expect(await response.text()).toContain("That voice session is unavailable.");
          expect((await end(token)).status).toBe(404);
        }
        // The same client without orchestration:operate is refused before ownership.
        expect((await heartbeat("dpop-key-a-read-only")).status).toBe(403);
        expect((await end("dpop-key-a-read-only")).status).toBe(403);
        expect(providerFetch).toHaveBeenCalledOnce();

        expect((await end("dpop-key-a-renewed")).status).toBe(200);
        expect(providerFetch).toHaveBeenCalledTimes(2);
      });
    },
  );

  it.effect("keeps cookie voice sessions owned by their own browser session", () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST" && String(input) === "https://api.openai.com/v1/live/sessions") {
        return new Response(
          JSON.stringify({
            session: { id: "provider-session" },
            transport: { sdp: "v=0\\r\\nanswer" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    return withHandler({ initialApiKey: API_KEY, fetch: providerFetch }, async (environment) => {
      const created = await call(
        environment,
        post("/api/voice/sessions", createPayload, "cookie-same-subject"),
      );
      expect(created.status).toBe(200);
      const otherSession = await call(
        environment,
        post(
          "/api/voice/sessions/heartbeat",
          { sessionId: SESSION_ID },
          "cookie-same-subject-other-session",
        ),
      );
      expect(otherSession.status).toBe(404);
      const owner = await call(
        environment,
        post("/api/voice/sessions/end", { sessionId: SESSION_ID }, "cookie-same-subject"),
      );
      expect(owner.status).toBe(200);
    });
  });

  it.effect("restricts heartbeat and end to the session owner", () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST" && String(input) === "https://api.openai.com/v1/live/sessions") {
        return new Response(
          JSON.stringify({
            session: { id: "provider-session" },
            transport: { sdp: "v=0\\r\\nanswer" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    return withHandler({ initialApiKey: API_KEY, fetch: providerFetch }, async (environment) => {
      const created = await call(
        environment,
        post("/api/voice/sessions", createPayload, "operate"),
      );
      expect(created.status).toBe(200);

      const otherHeartbeat = await call(
        environment,
        post("/api/voice/sessions/heartbeat", { sessionId: SESSION_ID }, "operate-other"),
      );
      expect(otherHeartbeat.status).toBe(404);
      expect(await otherHeartbeat.text()).toContain("That voice session is unavailable.");

      const otherEnd = await call(
        environment,
        post("/api/voice/sessions/end", { sessionId: SESSION_ID }, "operate-other"),
      );
      expect(otherEnd.status).toBe(404);
      expect(await otherEnd.text()).toContain("That voice session is unavailable.");

      const ownerHeartbeat = await call(
        environment,
        post("/api/voice/sessions/heartbeat", { sessionId: SESSION_ID }, "operate"),
      );
      expect(ownerHeartbeat.status).toBe(200);

      const ownerEnd = await call(
        environment,
        post("/api/voice/sessions/end", { sessionId: SESSION_ID }, "operate"),
      );
      expect(ownerEnd.status).toBe(200);
      expect(providerFetch).toHaveBeenCalledTimes(2);
    });
  });

  it.effect("VH-HT1 a history failure on end still hangs up the owner's audio first", () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST" && String(input) === "https://api.openai.com/v1/live/sessions") {
        return new Response(
          JSON.stringify({
            session: { id: "provider-session" },
            transport: { sdp: "v=0\\r\\nanswer" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    const storageFailure = new VoiceConversationError({
      status: 502,
      message: "The voice history could not be saved or read. Try again.",
    });
    return withHandler(
      {
        initialApiKey: API_KEY,
        fetch: providerFetch,
        history: {
          end: () => Effect.fail(storageFailure),
        },
      },
      async (environment) => {
        const created = await call(
          environment,
          post("/api/voice/sessions", createPayload, "operate"),
        );
        expect(created.status).toBe(200);

        // The live session rejects a foreign client before the history is read: no hangup.
        const otherEnd = await call(
          environment,
          post("/api/voice/sessions/end", { sessionId: SESSION_ID }, "operate-other"),
        );
        expect(otherEnd.status).toBe(404);
        expect(providerFetch).toHaveBeenCalledTimes(1);

        const ownerEnd = await call(
          environment,
          post("/api/voice/sessions/end", { sessionId: SESSION_ID, lastSequence: 2 }, "operate"),
        );
        expect(ownerEnd.status).toBe(502);
        expect(await ownerEnd.text()).toContain("could not be saved or read");
        expect(providerFetch).toHaveBeenCalledTimes(2);
        const heartbeat = await call(
          environment,
          post("/api/voice/sessions/heartbeat", { sessionId: SESSION_ID }, "operate"),
        );
        expect(heartbeat.status).toBe(404);
      },
    );
  });
});
