// Entry point: the voice history HTTP operations of voiceConversationHttp.ts through the real
// executeAuthenticatedEnvironmentHttpRequest (per-request authorization, credential retry and
// fetch). Authorization, proof signing and the environment's responses are synthetic; every
// outbound request records which authenticated owner its credential belonged to.
import { EnvironmentId, type VoiceTranscriptAppendInput } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";

import { RemoteEnvironmentAuthorization } from "./authorization/service.ts";
import { RelayConnectionTarget, type PreparedConnection } from "./connection/model.ts";
import { ManagedRelayDpopSigner } from "./relay/managedRelay.ts";
import { remoteHttpClientLayer } from "./rpc/http.ts";
import {
  appendVoiceTranscript,
  createVoiceHistoryOwnerGuard,
  endVoiceConversation,
  listVoiceCalls,
  listVoiceTranscript,
  readVoiceCall,
} from "./voiceConversationHttp.ts";
import {
  resumeVoiceHistoryOutbox,
  type VoiceHistoryClient,
  type VoiceHistoryPendingBatch,
  type VoiceHistoryPendingStore,
} from "./voice/history.ts";

const ORIGIN = "https://environment.example.test";
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const TARGET = new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Remote" });
const CALL_ID = "voice-history-call-0001";
const SAVED_TEXT = "Saved under owner A.";

interface Outbound {
  readonly path: string;
  readonly credential: string | null;
  /** The owner the synthetic environment authenticates for this request's credential. */
  readonly owner: string | null;
  readonly body: unknown;
}

/** Runs a fully provided Effect for the Promise-based outbox, inside the test's scope. */
type RunPromise = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;

/** The outbox under test is Promise-based; this bridges it to the scoped test fiber. */
const scenario = (body: (run: RunPromise) => Promise<void>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const run = yield* FiberSet.makeRuntimePromise();
      yield* Effect.promise(() => body(run));
    }),
  );

const owner = { environmentId: ENVIRONMENT_ID, clientIdentity: "owner-a" };
const pendingBatch: VoiceHistoryPendingBatch = {
  owner,
  threadId: "thread-1",
  callId: CALL_ID,
  batchId: "batch-1",
  fragments: [{ fragmentId: "fragment-1", sequence: 1, speaker: "user", text: SAVED_TEXT }],
};

/**
 * A synthetic environment. `ownerByCredential` is the server's verified binding of each header
 * credential; `cookieOwner` is the identity of the browser's current session cookie.
 */
const makeEnvironment = (options: {
  readonly prepared: PreparedConnection;
  /** The token authorization resolves next; a retry receives `renewedToken`. */
  readonly currentToken?: string;
  readonly renewedToken?: string;
  readonly ownerByCredential: Readonly<Record<string, string>>;
  readonly cookieOwner?: string;
  readonly call?: { endedAt: string | null; finalSequence: number | null };
  /** Runs after each response is built: tests change identity at precise points. */
  readonly afterResponse?: (path: string) => void;
}) => {
  const outbound: Outbound[] = [];
  const authorizations: Array<string | undefined> = [];
  let token = options.currentToken ?? "unused";
  let cookieOwner = options.cookieOwner ?? null;
  const rejectedTokens = new Set<string>();
  const call = options.call ?? { endedAt: null, finalSequence: null };
  const remote = RemoteEnvironmentAuthorization.of({
    authorizeBearer: () => Effect.die("unused"),
    authorizeDpop: () => Effect.die("unused"),
    authorizeDpopHttp: (input) =>
      Effect.sync(() => {
        authorizations.push(input.rejectedAccessToken);
        if (input.rejectedAccessToken !== undefined && options.renewedToken)
          token = options.renewedToken;
        return {
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          httpBaseUrl: ORIGIN,
          httpAuthorization: { _tag: "Dpop", accessToken: token, expiresAtEpochMs: 9e15 },
        };
      }),
  });
  const signer = ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("same-proof-key"),
    createProof: () => Effect.succeed("synthetic-proof"),
  });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const header = new Headers(init?.headers).get("authorization");
    const credential = header ? header.replace(/^(DPoP|Bearer) /, "") : null;
    const authenticated =
      credential === null
        ? init?.credentials === "include"
          ? cookieOwner
          : null
        : (options.ownerByCredential[credential] ?? null);
    const rawBody = init?.body ? await new Response(init.body).text() : null;
    outbound.push({
      path: url.pathname,
      credential,
      owner: authenticated,
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    const respond = (response: Response) => {
      options.afterResponse?.(url.pathname);
      return response;
    };
    if (credential !== null && rejectedTokens.has(credential))
      return respond(
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-rejected",
          },
          { status: 401 },
        ),
      );
    if (url.pathname === "/api/voice/settings")
      return respond(
        Response.json({
          configured: true,
          canConfigure: false,
          model: "gpt-live-1",
          maxDurationSeconds: 900,
          ...(authenticated ? { historyOwnerId: authenticated } : {}),
        }),
      );
    if (url.pathname.endsWith("/calls"))
      return respond(
        Response.json({
          calls: [
            {
              callId: CALL_ID,
              threadId: "thread-1",
              startedAt: "2026-11-08T10:00:00.000Z",
              endedAt: "2026-11-08T10:05:00.000Z",
              endReason: "hangup",
              finalSequence: 1,
              lastSequence: 1,
              ownedByRequester: authenticated === "owner-a",
            },
          ],
          nextCursor: "page-2",
        }),
      );
    if (url.pathname.endsWith("/fragments"))
      return respond(
        Response.json({
          call: {
            callId: CALL_ID,
            threadId: "thread-1",
            startedAt: "2026-11-08T10:00:00.000Z",
            endedAt: call.endedAt,
            endReason: call.endedAt ? "expired" : null,
            finalSequence: call.finalSequence,
            lastSequence: 0,
            ownedByRequester: authenticated === "owner-a",
          },
          fragments: [],
          nextAfterSequence: null,
        }),
      );
    if (url.pathname === "/api/voice/sessions/end") {
      call.finalSequence ??= (JSON.parse(rawBody!) as { lastSequence: number }).lastSequence;
      return respond(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/voice/sessions/transcript")
      return respond(Response.json({ lastSequence: 1 }));
    return respond(Response.json({}, { status: 404 }));
  };
  const layer = Layer.mergeAll(
    remoteHttpClientLayer(fetcher as typeof fetch),
    Layer.succeed(RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ManagedRelayDpopSigner, signer),
  );
  const client = (run: RunPromise, isCurrent: () => boolean = () => true): VoiceHistoryClient => {
    const guard = createVoiceHistoryOwnerGuard({ historyOwnerId: "owner-a", isCurrent });
    return {
      append: (payload: VoiceTranscriptAppendInput) =>
        run(appendVoiceTranscript(options.prepared, payload, guard).pipe(Effect.provide(layer))),
      readCall: (input) =>
        run(readVoiceCall(options.prepared, input, guard).pipe(Effect.provide(layer))),
      end: ({ callId, lastSequence }) =>
        run(
          endVoiceConversation(options.prepared, callId, lastSequence, guard).pipe(
            Effect.provide(layer),
            Effect.asVoid,
          ),
        ),
    };
  };
  const transcriptRequests = () =>
    outbound.filter((request) => request.path === "/api/voice/sessions/transcript");
  return {
    outbound,
    authorizations,
    layer,
    client,
    transcriptRequests,
    call,
    /** The credential the next authorization resolves to, as after a re-pair. */
    setToken: (next: string) => {
      token = next;
    },
    /** The environment rejects this credential from now on. */
    rejectToken: (rejected: string) => {
      rejectedTokens.add(rejected);
    },
    /** The browser's session cookie now authenticates another owner. */
    setCookieOwner: (next: string) => {
      cookieOwner = next;
    },
  };
};

const makeStore = () => {
  const backing = new Map([[pendingBatch.batchId, pendingBatch]]);
  const store: VoiceHistoryPendingStore = {
    list: async () => [...backing.values()],
    put: async (batch) => {
      backing.set(batch.batchId, batch);
    },
    remove: async (batch) => {
      backing.delete(batch.batchId);
    },
  };
  return { store, backing };
};

const relayConnection: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  httpBaseUrl: ORIGIN,
  socketUrl: "wss://environment.example.test/ws",
  // The prepared credential is stale; every request resolves its own authorization.
  httpAuthorization: { _tag: "Dpop", accessToken: "prepared-token", expiresAtEpochMs: 0 },
  target: TARGET,
};

const cookieConnection: PreparedConnection = {
  ...relayConnection,
  httpAuthorization: null,
};

/** Every request whose body carries the saved transcript text. */
const textCarriers = (outbound: ReadonlyArray<Outbound>) =>
  outbound.filter((request) => JSON.stringify(request.body ?? null).includes(SAVED_TEXT));

describe("voice history requests bound to the verified owner", () => {
  it.effect(
    "voice history owner guard sends no saved text when identity changes after the ownership read and the view closed",
    () =>
      scenario(async (run) => {
        let current = true;
        const environment = makeEnvironment({
          prepared: relayConnection,
          currentToken: "token-a",
          ownerByCredential: { "token-a": "owner-a", "token-b": "owner-b" },
          afterResponse: (path) => {
            if (path.endsWith("/fragments")) {
              environment.setToken("token-b");
              current = false;
            }
          },
        });
        const { store, backing } = makeStore();

        const result = await resumeVoiceHistoryOutbox({
          owner,
          store,
          client: environment.client(run, () => current),
        });

        expect(textCarriers(environment.outbound)).toEqual([]);
        expect(backing.size).toBe(1);
        expect(result).toMatchObject({ sent: 0, retained: 1 });
      }),
  );

  it.effect(
    "voice history owner guard sends no saved text when identity changes while the view stays current",
    () =>
      scenario(async (run) => {
        const environment = makeEnvironment({
          prepared: relayConnection,
          currentToken: "token-a",
          ownerByCredential: { "token-a": "owner-a", "token-b": "owner-b" },
          afterResponse: (path) => {
            if (path.endsWith("/fragments")) environment.setToken("token-b");
          },
        });
        const { store, backing } = makeStore();

        const result = await resumeVoiceHistoryOutbox({
          owner,
          store,
          client: environment.client(run),
        });

        expect(textCarriers(environment.outbound)).toEqual([]);
        // The guard asked the environment, with the new credential, which owner it is.
        expect(environment.outbound.at(-1)).toMatchObject({
          path: "/api/voice/settings",
          credential: "token-b",
          owner: "owner-b",
        });
        expect(backing.size).toBe(1);
        expect(result.errors).toEqual([expect.stringMatching(/another identity/)]);
      }),
  );

  it.effect(
    "voice history owner guard sends no saved text when a credential retry resolves another identity",
    () =>
      scenario(async (run) => {
        const environment = makeEnvironment({
          prepared: relayConnection,
          currentToken: "token-a",
          renewedToken: "token-b",
          ownerByCredential: { "token-a": "owner-a", "token-b": "owner-b" },
          afterResponse: (path) => {
            // The first transcript attempt is rejected; its retry renews into another identity.
            if (path.endsWith("/fragments")) environment.rejectToken("token-a");
          },
        });
        const { store, backing } = makeStore();

        await resumeVoiceHistoryOutbox({ owner, store, client: environment.client(run) });

        expect(environment.authorizations).toContain("token-a");
        // The rejected attempt carried owner A's credential; nothing went out under owner B.
        expect(textCarriers(environment.outbound).map((request) => request.owner)).toEqual([
          "owner-a",
        ]);
        expect(backing.size).toBe(1);
      }),
  );

  it.effect(
    "voice history owner guard sends after a credential renewal the environment confirms as the same owner",
    () =>
      scenario(async (run) => {
        const environment = makeEnvironment({
          prepared: relayConnection,
          currentToken: "token-a",
          renewedToken: "token-a-renewed",
          ownerByCredential: { "token-a": "owner-a", "token-a-renewed": "owner-a" },
          afterResponse: (path) => {
            if (path.endsWith("/fragments")) environment.rejectToken("token-a");
          },
        });
        const { store, backing } = makeStore();

        const result = await resumeVoiceHistoryOutbox({
          owner,
          store,
          client: environment.client(run),
        });

        const carriers = textCarriers(environment.outbound);
        expect(carriers.at(-1)).toMatchObject({ credential: "token-a-renewed", owner: "owner-a" });
        expect(carriers.every((request) => request.owner === "owner-a")).toBe(true);
        expect(result).toMatchObject({ sent: 1, retained: 0 });
        expect(backing.size).toBe(0);
      }),
  );

  it.effect(
    "voice history owner guard stops a resume whose host left, without deleting the batch",
    () =>
      scenario(async (run) => {
        let current = true;
        const environment = makeEnvironment({
          prepared: relayConnection,
          currentToken: "token-a",
          ownerByCredential: { "token-a": "owner-a" },
          afterResponse: (path) => {
            if (path.endsWith("/fragments")) current = false;
          },
        });
        const { store, backing } = makeStore();

        await resumeVoiceHistoryOutbox({
          owner,
          store,
          client: environment.client(run, () => current),
        });

        expect(textCarriers(environment.outbound)).toEqual([]);
        expect(backing.size).toBe(1);
      }),
  );

  it.effect(
    "voice history owner guard completes a same-owner final boundary and append under that owner",
    () =>
      scenario(async (run) => {
        const environment = makeEnvironment({
          prepared: relayConnection,
          currentToken: "token-a",
          ownerByCredential: { "token-a": "owner-a" },
          call: { endedAt: "2026-11-08T10:05:00.000Z", finalSequence: null },
        });
        const { store, backing } = makeStore();

        const result = await resumeVoiceHistoryOutbox({
          owner,
          store,
          client: environment.client(run),
        });

        const protectedPaths = environment.outbound
          .filter((request) => request.path !== "/api/voice/settings")
          .map((request) => request.path);
        expect(protectedPaths).toEqual([
          `/api/voice/threads/thread-1/calls/${CALL_ID}/fragments`,
          "/api/voice/sessions/end",
          "/api/voice/sessions/transcript",
        ]);
        expect(environment.outbound.every((request) => request.owner === "owner-a")).toBe(true);
        // The verified credential is confirmed once, not before every request.
        expect(
          environment.outbound.filter((request) => request.path === "/api/voice/settings"),
        ).toHaveLength(1);
        expect(environment.call.finalSequence).toBe(1);
        expect(result).toMatchObject({ sent: 1, retained: 0 });
        expect(backing.size).toBe(0);
      }),
  );

  it.effect(
    "voice history owner guard confirms a cookie session before every request and stops when it changes",
    () =>
      scenario(async (run) => {
        const environment = makeEnvironment({
          prepared: cookieConnection,
          ownerByCredential: {},
          cookieOwner: "owner-a",
          afterResponse: (path) => {
            if (path.endsWith("/fragments")) environment.setCookieOwner("owner-b");
          },
        });
        const { store, backing } = makeStore();

        await resumeVoiceHistoryOutbox({ owner, store, client: environment.client(run) });

        expect(environment.outbound.map((request) => [request.path, request.owner])).toEqual([
          ["/api/voice/settings", "owner-a"],
          [`/api/voice/threads/thread-1/calls/${CALL_ID}/fragments`, "owner-a"],
          ["/api/voice/settings", "owner-b"],
        ]);
        expect(textCarriers(environment.outbound)).toEqual([]);
        expect(backing.size).toBe(1);
      }),
  );
});

// Phase 4 fence: the saved-history viewer only reads. Any client with orchestration:read can open
// another owner's finished call, so it must not use the outbox owner guard as read permission.
describe("voice history viewer reads", () => {
  it.effect(
    "voice history viewer lists another owner's calls and transcript without an owner check or a write",
    () =>
      scenario(async (run) => {
        const environment = makeEnvironment({
          prepared: relayConnection,
          currentToken: "token-b",
          ownerByCredential: { "token-b": "owner-b" },
          call: { endedAt: "2026-11-08T10:05:00.000Z", finalSequence: 1 },
        });

        const page = await run(
          listVoiceCalls(relayConnection, {
            threadId: "thread-1",
            cursor: "page-1",
            limit: 20,
          }).pipe(Effect.provide(environment.layer)),
        );
        const transcript = await run(
          listVoiceTranscript(relayConnection, {
            threadId: "thread-1",
            callId: CALL_ID,
            afterSequence: 0,
            limit: 50,
          }).pipe(Effect.provide(environment.layer)),
        );

        expect(page.calls.map((call) => call.callId)).toEqual([CALL_ID]);
        expect(transcript.call.callId).toBe(CALL_ID);
        // Reads go only to the typed history routes, under the reader's own credential.
        expect(environment.outbound.map((request) => request.path)).toEqual([
          "/api/voice/threads/thread-1/calls",
          `/api/voice/threads/thread-1/calls/${CALL_ID}/fragments`,
        ]);
        expect(environment.outbound.every((request) => request.owner === "owner-b")).toBe(true);
        expect(environment.outbound.every((request) => request.body === null)).toBe(true);
      }),
  );
});
