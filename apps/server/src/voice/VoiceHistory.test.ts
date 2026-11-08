// @effect-diagnostics nodeBuiltinImport:off - the replay spec edits the closed SQLite file directly.
// Phase 2 fence: persisted voice history, exercised through the real voice HTTP entry point
// (`voiceConversationHttpApiLayer` served by `HttpApiBuilder.layer` + `HttpRouter.toWebHandler`)
// over the real `OrchestrationEngineLive`, `OrchestrationProjectionPipelineLive`, event store,
// command receipts and a SQLite file that survives a simulated server restart. Only the
// authentication middleware (principals the real middleware would produce), the secret store and
// the OpenAI Live endpoint are test doubles.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentHttpApi,
  type EnvironmentSessionPrincipalShape,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionVoiceCallRepositoryLive } from "../persistence/Layers/ProjectionVoiceCalls.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { voiceConversationHttpApiLayer } from "./http.ts";
import { VoiceHistoryLive } from "./VoiceHistory.ts";
import { VoiceSessionManagerConfig } from "./VoiceSessionManager.ts";
import { makeVoiceTestAuthLayer } from "./voiceHttp.testFixtures.ts";

const API_KEY = `sk-${"voice-history-".repeat(3)}`;
const PROJECT_ID = ProjectId.make("project-voice-history");
const THREAD_ID = ThreadId.make("thread-voice-history");
const OTHER_THREAD_ID = ThreadId.make("thread-voice-history-other");
const VOICE_PROJECTOR = "projection.voice-calls";
const VOICE_EVENT_TYPES = new Set([
  "thread.voice-call-started",
  "thread.voice-transcript-appended",
  "thread.voice-call-ended",
]);

class VoiceTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.voice) {}

const cookiePrincipal = (
  sessionId: string,
  scopes: ReadonlyArray<typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope>,
): EnvironmentSessionPrincipalShape => ({
  sessionId: sessionId as EnvironmentSessionPrincipalShape["sessionId"],
  subject: "voice-history-client",
  method: "browser-session-cookie",
  scopes: new Set(scopes),
});

// Principals the real auth middleware would produce. Cookie ownership is per auth session, so
// these are three distinct clients of one user, with the same identity after a restart.
const principalsByToken: Readonly<Record<string, EnvironmentSessionPrincipalShape>> = {
  owner: cookiePrincipal("session-owner", [
    AuthOrchestrationOperateScope,
    AuthOrchestrationReadScope,
  ]),
  viewer: cookiePrincipal("session-viewer", [AuthOrchestrationReadScope]),
  intruder: cookiePrincipal("session-intruder", [
    AuthOrchestrationOperateScope,
    AuthOrchestrationReadScope,
  ]),
};

const authLayer = makeVoiceTestAuthLayer(
  (token) => principalsByToken[token] ?? cookiePrincipal(`session-${token}`, []),
);

const secretStoreLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
  get: (name) =>
    Effect.succeed(
      name === "voice-openai-api-key"
        ? Option.some(new TextEncoder().encode(API_KEY))
        : Option.none(),
    ),
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.die("Not used by voice history tests."),
  remove: () => Effect.void,
} satisfies ServerSecretStore.ServerSecretStore["Service"]);

let providerSessionCount = 0;
let providerHangupCount = 0;
let failingProviderHangups = 0;
const fakeOpenAiLive: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/hangup")) {
    if (failingProviderHangups > 0) {
      failingProviderHangups -= 1;
      return new Response(null, { status: 500 });
    }
    providerHangupCount += 1;
    return new Response(null, { status: 200 });
  }
  providerSessionCount += 1;
  return Response.json({
    session: { id: `provider-session-${providerSessionCount}` },
    transport: { sdp: "v=0\r\no=answer" },
  });
};

const makeCoreLayer = (databasePath: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(databasePath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-history-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const makeServerLayer = (databasePath: string) =>
  VoiceHistoryLive.pipe(
    Layer.provide(ProjectionVoiceCallRepositoryLive),
    Layer.provideMerge(makeCoreLayer(databasePath)),
  );

type ServerServices = OrchestrationEngineService | ProjectionSnapshotQuery;

interface RunningServer {
  readonly request: (request: Request) => Effect.Effect<Response>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, ServerServices>) => Effect.Effect<A, E>;
  readonly scope: Scope.Closeable;
}

/** The live call manager's clock and sweep, driven by the test instead of a timer. */
interface CallClock {
  now: number;
  sweep: (() => Promise<void>) | undefined;
}

/**
 * One server process: engine, projections, voice history and the voice HTTP routes, all owned by
 * one scope. Closing that scope and starting again on the same file is a server restart.
 */
const startServer = Effect.fn("startServer")(function* (databasePath: string, clock: CallClock) {
  const scope = yield* Scope.make();
  const services = yield* Layer.buildWithScope(makeServerLayer(databasePath), scope);
  const routesLayer = HttpApiBuilder.layer(VoiceTestApi).pipe(
    Layer.provide(voiceConversationHttpApiLayer),
    Layer.provide(
      Layer.succeed(VoiceSessionManagerConfig, {
        now: () => clock.now,
        scheduleSweep: (sweep) => {
          clock.sweep = sweep;
          return () => {
            if (clock.sweep === sweep) clock.sweep = undefined;
          };
        },
      }),
    ),
    Layer.provide(authLayer),
    Layer.provide(secretStoreLayer),
    Layer.provide(Layer.succeedContext(services)),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const web = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  // Finalizers run in reverse: the HTTP routes and their call manager close before the engine.
  yield* Scope.addFinalizer(
    scope,
    Effect.promise(() => web.dispose()),
  );
  return {
    request: (request) =>
      Effect.promise(() => web.handler(request, Context.empty() as Context.Context<unknown>)),
    run: (effect) => effect.pipe(Effect.provide(services)),
    scope,
  } satisfies RunningServer;
});

const stopServer = (server: RunningServer) => Scope.close(server.scope, Exit.void);

/** A disposable database and the OpenAI double; every started server stops with the test. */
const makeHarness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-history-" });
  const databasePath = path.join(directory, "state.sqlite");
  const running = new Set<RunningServer>();
  const clock: CallClock = { now: Date.parse("2026-11-08T10:00:00.000Z"), sweep: undefined };
  yield* Effect.acquireRelease(
    Effect.sync(() => vi.stubGlobal("fetch", fakeOpenAiLive)),
    () => Effect.sync(() => vi.unstubAllGlobals()),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(running, stopServer, { discard: true }).pipe(
      Effect.ensuring(Effect.sync(() => running.clear())),
    ),
  );
  const boot = Effect.gen(function* () {
    const server = yield* startServer(databasePath, clock);
    running.add(server);
    return server;
  });
  const stop = Effect.fn("stop")(function* (server: RunningServer) {
    running.delete(server);
    yield* stopServer(server);
  });
  const restart = Effect.fn("restart")(function* (server: RunningServer) {
    yield* stop(server);
    return yield* boot;
  });
  /** Advance the live call clock, then run one sweep and its persisted server-side ends. */
  const advanceCallClock = (milliseconds: number) =>
    Effect.promise(async () => {
      clock.now += milliseconds;
      await clock.sweep?.();
    });
  return { databasePath, boot, stop, restart, advanceCallClock };
});

const createThread = (server: RunningServer, threadId: ThreadId, createProject: boolean) =>
  server.run(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
      if (createProject) {
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`cmd-project-${threadId}`),
          projectId: PROJECT_ID,
          title: "Voice history project",
          workspaceRoot: "/tmp/voice-history-project",
          defaultModelSelection: modelSelection,
          createdAt,
        });
      }
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`cmd-thread-${threadId}`),
        threadId,
        projectId: PROJECT_ID,
        title: "Voice history thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });
    }),
  );

const bootWithThread = Effect.gen(function* () {
  const harness = yield* makeHarness;
  const server = yield* harness.boot;
  yield* createThread(server, THREAD_ID, true);
  return { harness, server };
});

const jsonRequest = (method: "GET" | "POST", path: string, token: string, body?: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface Fragment {
  readonly fragmentId: string;
  readonly sequence: number;
  readonly speaker: "user" | "assistant";
  readonly text: string;
  readonly startOffsetMs?: number;
  readonly endOffsetMs?: number;
}

const fragment = (sequence: number, text: string, offsets = true): Fragment => ({
  fragmentId: `fragment-${String(sequence).padStart(4, "0")}`,
  sequence,
  speaker: sequence % 2 === 1 ? "user" : "assistant",
  text,
  ...(offsets ? { startOffsetMs: sequence * 1_000, endOffsetMs: sequence * 1_000 + 800 } : {}),
});

const voice = (server: RunningServer) => ({
  start: (token: string, sessionId: string, threadId: ThreadId = THREAD_ID) =>
    server.request(
      jsonRequest("POST", "/api/voice/sessions", token, {
        sessionId,
        threadId,
        sdp: "v=0\r\no=offer",
        voice: "cedar",
        language: "es",
        mode: "discuss",
      }),
    ),
  append: (token: string, sessionId: string, batchId: string, fragments: ReadonlyArray<Fragment>) =>
    server.request(
      jsonRequest("POST", "/api/voice/sessions/transcript", token, {
        sessionId,
        batchId,
        fragments,
      }),
    ),
  heartbeat: (token: string, sessionId: string) =>
    server.request(jsonRequest("POST", "/api/voice/sessions/heartbeat", token, { sessionId })),
  end: (token: string, sessionId: string, lastSequence?: number) =>
    server.request(
      jsonRequest("POST", "/api/voice/sessions/end", token, {
        sessionId,
        ...(lastSequence === undefined ? {} : { lastSequence }),
      }),
    ),
  listCalls: (token: string, query = "", threadId: ThreadId = THREAD_ID) =>
    server.request(jsonRequest("GET", `/api/voice/threads/${threadId}/calls${query}`, token)),
  listFragments: (token: string, callId: string, query = "", threadId: ThreadId = THREAD_ID) =>
    server.request(
      jsonRequest("GET", `/api/voice/threads/${threadId}/calls/${callId}/fragments${query}`, token),
    ),
});

interface CallSummary {
  readonly callId: string;
  readonly threadId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly finalSequence: number | null;
  readonly ownedByRequester: boolean;
}
interface CallPage {
  readonly calls: ReadonlyArray<CallSummary>;
  readonly nextCursor: string | null;
}
interface FragmentPage {
  readonly call: CallSummary;
  readonly fragments: ReadonlyArray<Fragment>;
  readonly nextAfterSequence: number | null;
}

const expectStatus = Effect.fn("expectStatus")(function* (
  response: Effect.Effect<Response>,
  status: number,
) {
  const resolved = yield* response;
  const body = yield* Effect.promise(() => resolved.text());
  expect(resolved.status, body).toBe(status);
  return body;
});
// The specs read raw HTTP bodies, as a client would, rather than through the server schemas.
const parseJson = <A>(body: string): A => JSON.parse(body) as A;
const asJsonText = (value: unknown): string => JSON.stringify(value);
const expectJson = <A>(response: Effect.Effect<Response>) =>
  expectStatus(response, 200).pipe(Effect.map((body) => parseJson<A>(body)));

/** Every fragment of a call, read through the bounded keyset pages. */
const readAllFragments = Effect.fn("readAllFragments")(function* (
  server: RunningServer,
  token: string,
  callId: string,
) {
  const fragments: Fragment[] = [];
  let query = "?limit=2";
  for (let page = 0; page < 50; page += 1) {
    const result = yield* expectJson<FragmentPage>(
      voice(server).listFragments(token, callId, query),
    );
    fragments.push(...result.fragments);
    if (result.nextAfterSequence === null) return { call: result.call, fragments };
    query = `?limit=2&afterSequence=${result.nextAfterSequence}`;
  }
  return yield* Effect.die(new Error("Fragment pagination did not terminate."));
});

const readEvents = (server: RunningServer, fromSequenceExclusive: number) =>
  server.run(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      return Array.from(
        yield* Stream.runCollect(engine.readEvents(fromSequenceExclusive, 10_000)),
      ) as OrchestrationEvent[];
    }),
  );

/** Delete the voice projection rows and cursor of a stopped server; returns the fragment count. */
const dropVoiceProjection = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    const projectedRows = database
      .prepare("SELECT COUNT(*) AS count FROM projection_voice_fragments")
      .get() as { count: number };
    database.exec("DELETE FROM projection_voice_fragments");
    database.exec("DELETE FROM projection_voice_batches");
    database.exec("DELETE FROM projection_voice_calls");
    database.prepare("DELETE FROM projection_state WHERE projector = ?").run(VOICE_PROJECTOR);
    return projectedRows.count;
  } finally {
    database.close();
  }
};

/**
 * Make the store reject (or accept again) every voice-call end event. The trigger lives in the
 * disposable database only and stands in for a transient write failure.
 */
const setVoiceEndWriteFailure = (databasePath: string, failing: boolean) => {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec(
      failing
        ? `CREATE TRIGGER voice_end_write_failure BEFORE INSERT ON orchestration_events
           WHEN NEW.event_type = 'thread.voice-call-ended'
           BEGIN SELECT RAISE(ABORT, 'transient voice end write failure'); END;`
        : "DROP TRIGGER IF EXISTS voice_end_write_failure",
    );
  } finally {
    database.close();
  }
};

/**
 * Put a stopped server's file back in the state of a database that ran migration 53 but not 54:
 * the batch identity table and its migration record are removed, while events, receipts, voice
 * rows and the voice projector cursor stay as they are.
 */
const rollBackToMigration53 = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec("DROP TABLE projection_voice_batches");
    database.exec("DELETE FROM effect_sql_migrations WHERE migration_id = 54");
  } finally {
    database.close();
  }
};

const headSequence = (server: RunningServer) =>
  readEvents(server, 0).pipe(Effect.map((events) => events.at(-1)?.sequence ?? 0));

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "persisted voice history phase 2 fence",
  (it) => {
    it.effect(
      "VH-H1 AC1 returns the original spoken fragments in order after a server restart",
      () =>
        Effect.gen(function* () {
          const { harness, server } = yield* bootWithThread;
          const callId = "voice-call-restart-0001";
          const spoken = [
            fragment(1, "  Hola, ¿podés revisar el test?"),
            fragment(2, " Sí, lo reviso ahora mismo."),
            fragment(3, "¿Y el lint…?", false),
            fragment(4, " También, después del test. "),
          ];
          yield* expectStatus(voice(server).start("owner", callId), 200);
          const first = yield* expectJson<{ lastSequence: number }>(
            voice(server).append("owner", callId, "batch-0001", spoken.slice(0, 2)),
          );
          expect(first.lastSequence).toBe(2);
          const second = yield* expectJson<{ lastSequence: number }>(
            voice(server).append("owner", callId, "batch-0002", spoken.slice(2)),
          );
          expect(second.lastSequence).toBe(4);

          const restarted = yield* harness.restart(server);
          const history = yield* readAllFragments(restarted, "viewer", callId);
          expect(history.fragments).toEqual(spoken);
          // The call had no hangup before the restart: it is recovered as interrupted.
          expect(history.call.callId).toBe(callId);
          expect(history.call.endedAt).not.toBeNull();
          expect(history.call.endReason).toBe("interrupted");
          // Persistence never reopens audio. Without a declared final boundary, an unsolicited
          // append to the recovered call is a conflict.
          yield* expectStatus(
            voice(restarted).append("owner", callId, "batch-0003", [fragment(5, "Otra cosa")]),
            409,
          );
        }),
    );

    it.effect(
      "VH-H2 AC2 lets a second read-only client read the same thread's calls without taking the call",
      () =>
        Effect.gen(function* () {
          const { server } = yield* bootWithThread;
          const callId = "voice-call-viewer-0001";
          const spoken = [
            fragment(1, "Contame el estado del PR."),
            fragment(2, " Está en revisión."),
          ];
          yield* expectStatus(voice(server).start("owner", callId), 200);
          yield* expectStatus(voice(server).append("owner", callId, "batch-0001", spoken), 200);

          const viewerBody = yield* expectStatus(voice(server).listCalls("viewer"), 200);
          const viewerCalls = parseJson<CallPage>(viewerBody);
          expect(viewerCalls.calls.map((call) => call.callId)).toEqual([callId]);
          expect(viewerCalls.calls[0]?.threadId).toBe(THREAD_ID);
          expect(viewerCalls.calls[0]?.ownedByRequester).toBe(false);
          expect(viewerCalls.calls[0]?.endedAt).toBeNull();
          // The owner's auth session is not exposed to other clients.
          expect(viewerBody).not.toContain("session-owner");
          const ownerCalls = yield* expectJson<CallPage>(voice(server).listCalls("owner"));
          expect(ownerCalls.calls[0]?.ownedByRequester).toBe(true);

          const viewerHistory = yield* readAllFragments(server, "viewer", callId);
          expect(viewerHistory.fragments).toEqual(spoken);

          // Reading does not acquire the microphone: a read-only client cannot start a call, and the
          // owner keeps its live call.
          yield* expectStatus(voice(server).start("viewer", "voice-call-viewer-0002"), 403);
          yield* expectStatus(voice(server).heartbeat("owner", callId), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0002", [fragment(3, "Gracias.")]),
            200,
          );
        }),
    );

    it.effect("VH-H3 AC3 re-sending an accepted batch does not duplicate fragments", () =>
      Effect.gen(function* () {
        const { server } = yield* bootWithThread;
        const callId = "voice-call-retry-0001";
        const batch = [fragment(1, "Corré los tests."), fragment(2, " Los corro.")];
        yield* expectStatus(voice(server).start("owner", callId), 200);
        const startSequence = yield* headSequence(server);
        const accepted = yield* expectJson<{ lastSequence: number }>(
          voice(server).append("owner", callId, "batch-0001", batch),
        );
        const retried = yield* expectJson<{ lastSequence: number }>(
          voice(server).append("owner", callId, "batch-0001", batch),
        );
        expect(retried).toEqual(accepted);
        const appendedEvents = (yield* readEvents(server, startSequence)).filter(
          (event) => event.type === ("thread.voice-transcript-appended" as string),
        );
        expect(appendedEvents).toHaveLength(1);

        // A client that lost the acknowledgement may re-batch the same fragments under a new ID.
        const rebatched = yield* expectJson<{ lastSequence: number }>(
          voice(server).append("owner", callId, "batch-0001-retry", batch),
        );
        expect(rebatched.lastSequence).toBe(2);
        expect((yield* readAllFragments(server, "owner", callId)).fragments).toEqual(batch);
      }),
    );

    it.effect("VH-H4 AC3 rejects a re-sent batch or fragment ID with different content", () =>
      Effect.gen(function* () {
        const { server } = yield* bootWithThread;
        const callId = "voice-call-conflict-0001";
        const batch = [fragment(1, "uno"), fragment(2, "dos")];
        yield* expectStatus(voice(server).start("owner", callId), 200);
        yield* expectStatus(voice(server).append("owner", callId, "batch-0001", batch), 200);

        // Same batch ID, changed text: the accepted-receipt path must not report success.
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0001", [
            batch[0]!,
            { ...batch[1]!, text: "DOS" },
          ]),
          409,
        );
        // New batch ID, an already stored sequence with other text.
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0002", [{ ...batch[1]!, text: "otro dos" }]),
          409,
        );
        // New batch ID, a stored fragment ID reused for new content.
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0003", [
            { ...fragment(3, "tres"), fragmentId: batch[1]!.fragmentId },
          ]),
          409,
        );
        expect((yield* readAllFragments(server, "owner", callId)).fragments).toEqual(batch);
      }),
    );

    it.effect("VH-H5 AC4 a client other than the owner cannot append to or end a call", () =>
      Effect.gen(function* () {
        const { server } = yield* bootWithThread;
        const callId = "voice-call-owner-0001";
        const batch = [fragment(1, "Esto es del propietario.")];
        yield* expectStatus(voice(server).start("owner", callId), 200);
        yield* expectStatus(voice(server).append("owner", callId, "batch-0001", batch), 200);

        const forged = [fragment(2, "Texto ajeno.")];
        yield* expectStatus(voice(server).append("intruder", callId, "batch-0002", forged), 404);
        yield* expectStatus(voice(server).append("viewer", callId, "batch-0002", forged), 403);
        yield* expectStatus(voice(server).end("intruder", callId, 2), 404);
        yield* expectStatus(voice(server).heartbeat("intruder", callId), 404);

        const history = yield* readAllFragments(server, "viewer", callId);
        expect(history.fragments).toEqual(batch);
        expect(history.call.endedAt).toBeNull();
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0002", [fragment(2, "Sigo yo.")]),
          200,
        );
      }),
    );

    it.effect(
      "VH-H6 AC4 an ended call accepts only the owner's pending flush up to its last sequence",
      () =>
        Effect.gen(function* () {
          const { server } = yield* bootWithThread;
          const callId = "voice-call-flush-0001";
          yield* expectStatus(voice(server).start("owner", callId), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0001", [
              fragment(1, "Chau."),
              fragment(2, " Chau!"),
            ]),
            200,
          );
          yield* expectStatus(voice(server).end("owner", callId, 3), 200);

          const ended = yield* expectJson<FragmentPage>(
            voice(server).listFragments("viewer", callId),
          );
          expect(ended.call.endedAt).not.toBeNull();
          expect(ended.call.endReason).toBe("hangup");

          const pending = fragment(3, "Último subtítulo pendiente.");
          yield* expectStatus(
            voice(server).append("intruder", callId, "batch-0002", [pending]),
            404,
          );
          yield* expectStatus(voice(server).append("owner", callId, "batch-0002", [pending]), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0003", [
              fragment(4, "Después del cierre."),
            ]),
            409,
          );
          expect(
            (yield* readAllFragments(server, "owner", callId)).fragments.map((f) => f.sequence),
          ).toEqual([1, 2, 3]);
          // The microphone is free again for the same owner.
          yield* expectStatus(voice(server).start("owner", "voice-call-flush-0002"), 200);
        }),
    );

    it.effect(
      "VH-H7 AC5 pages through every fragment in bounded keyset pages outside the thread snapshot",
      () =>
        Effect.gen(function* () {
          const { server } = yield* bootWithThread;
          const callId = "voice-call-pages-0001";
          const spoken = Array.from({ length: 7 }, (_, index) =>
            fragment(index + 1, ` marcador-voz-${index + 1} texto hablado`),
          );
          yield* expectStatus(voice(server).start("owner", callId), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0001", spoken.slice(0, 3)),
            200,
          );
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0002", spoken.slice(3, 5)),
            200,
          );
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0003", spoken.slice(5)),
            200,
          );

          const pageOne = yield* expectJson<FragmentPage>(
            voice(server).listFragments("viewer", callId, "?limit=3"),
          );
          expect(pageOne.fragments).toEqual(spoken.slice(0, 3));
          expect(pageOne.nextAfterSequence).toBe(3);
          const pageTwo = yield* expectJson<FragmentPage>(
            voice(server).listFragments("viewer", callId, "?limit=3&afterSequence=3"),
          );
          expect(pageTwo.fragments).toEqual(spoken.slice(3, 6));
          expect(pageTwo.nextAfterSequence).toBe(6);
          const pageThree = yield* expectJson<FragmentPage>(
            voice(server).listFragments("viewer", callId, "?limit=3&afterSequence=6"),
          );
          expect(pageThree.fragments).toEqual(spoken.slice(6));
          expect(pageThree.nextAfterSequence).toBeNull();
          yield* expectStatus(voice(server).listFragments("viewer", callId, "?limit=1000"), 400);

          const snapshots = yield* server.run(
            Effect.gen(function* () {
              const query = yield* ProjectionSnapshotQuery;
              return {
                detail: yield* query.getThreadDetailSnapshot(THREAD_ID),
                shell: yield* query.getShellSnapshot(),
                full: yield* query.getSnapshot(),
              };
            }),
          );
          expect(Option.isSome(snapshots.detail)).toBe(true);
          expect(asJsonText(snapshots.detail)).not.toContain("marcador-voz");
          expect(asJsonText(snapshots.shell)).not.toContain("marcador-voz");
          expect(asJsonText(snapshots.full)).not.toContain("marcador-voz");
        }),
    );

    it.effect(
      "VH-H8 AC5 lists a thread's calls in bounded pages without other threads' calls",
      () =>
        Effect.gen(function* () {
          const { server } = yield* bootWithThread;
          yield* createThread(server, OTHER_THREAD_ID, false);
          const callIds = ["voice-call-list-0001", "voice-call-list-0002", "voice-call-list-0003"];
          for (const callId of callIds) {
            yield* expectStatus(voice(server).start("owner", callId), 200);
            yield* expectStatus(
              voice(server).append("owner", callId, "batch-0001", [fragment(1, callId)]),
              200,
            );
            yield* expectStatus(voice(server).end("owner", callId, 1), 200);
          }
          yield* expectStatus(
            voice(server).start("owner", "voice-call-list-other", OTHER_THREAD_ID),
            200,
          );

          const first = yield* expectJson<CallPage>(voice(server).listCalls("viewer", "?limit=2"));
          expect(first.calls).toHaveLength(2);
          expect(first.nextCursor).not.toBeNull();
          const second = yield* expectJson<CallPage>(
            voice(server).listCalls(
              "viewer",
              `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
            ),
          );
          expect(second.nextCursor).toBeNull();
          const listed = [...first.calls, ...second.calls].map((call) => call.callId);
          expect(listed.toSorted()).toEqual(callIds);
          yield* expectStatus(voice(server).listCalls("viewer", "?limit=1000"), 400);
          const other = yield* expectJson<CallPage>(
            voice(server).listCalls("viewer", "", OTHER_THREAD_ID),
          );
          expect(other.calls.map((call) => call.callId)).toEqual(["voice-call-list-other"]);
        }),
    );

    it.effect("VH-H9 AC6 a deleted thread stops exposing its calls", () =>
      Effect.gen(function* () {
        const { harness, server } = yield* bootWithThread;
        const callId = "voice-call-deleted-0001";
        yield* expectStatus(voice(server).start("owner", callId), 200);
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0001", [fragment(1, "Borrame.")]),
          200,
        );
        yield* expectJson<CallPage>(voice(server).listCalls("viewer"));

        yield* server.run(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            yield* engine.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("cmd-voice-history-delete"),
              threadId: THREAD_ID,
            });
          }),
        );

        yield* expectStatus(voice(server).listCalls("viewer"), 404);
        yield* expectStatus(voice(server).listFragments("viewer", callId), 404);
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0002", [fragment(2, "Ya no.")]),
          404,
        );
        const restarted = yield* harness.restart(server);
        yield* expectStatus(voice(restarted).listCalls("owner"), 404);
        yield* expectStatus(voice(restarted).listFragments("owner", callId), 404);
      }),
    );

    it.effect("VH-H10 AC7 replaying the event store rebuilds the same voice history", () =>
      Effect.gen(function* () {
        const { harness, server } = yield* bootWithThread;
        for (const [index, callId] of [
          "voice-call-replay-0001",
          "voice-call-replay-0002",
        ].entries()) {
          yield* expectStatus(voice(server).start("owner", callId), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0001", [
              fragment(1, `Llamada ${index + 1}, pregunta.`),
              fragment(2, ` Llamada ${index + 1}, respuesta.`, false),
            ]),
            200,
          );
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0002", [fragment(3, "Listo.")]),
            200,
          );
          yield* expectStatus(voice(server).end("owner", callId, 3), 200);
        }
        const readHistory = Effect.fn("readHistory")(function* (running: RunningServer) {
          const calls = yield* expectJson<CallPage>(voice(running).listCalls("owner"));
          const fragments = yield* Effect.forEach(calls.calls, (call) =>
            readAllFragments(running, "owner", call.callId),
          );
          return { calls, fragments };
        });
        const before = yield* readHistory(server);
        expect(before.calls.calls).toHaveLength(2);
        yield* harness.stop(server);

        // Drop the rebuildable projection and its cursor; the event store stays the only record.
        expect(dropVoiceProjection(harness.databasePath)).toBe(6);

        const rebuilt = yield* harness.boot;
        const after = yield* readHistory(rebuilt);
        expect(after).toEqual(before);
      }),
    );

    it.effect(
      "VH-H11 AC8 voice history never starts an agent turn or changes thread messages",
      () =>
        Effect.gen(function* () {
          const { server } = yield* bootWithThread;
          const readWorkState = () =>
            server.run(
              Effect.gen(function* () {
                const query = yield* ProjectionSnapshotQuery;
                const detail = yield* query.getThreadDetailSnapshot(THREAD_ID);
                const shell = yield* query.getThreadShellById(THREAD_ID);
                const thread = Option.getOrThrow(detail).thread;
                return {
                  messages: thread.messages,
                  latestTurn: thread.latestTurn,
                  activities: thread.activities,
                  session: thread.session,
                  proposedPlans: thread.proposedPlans,
                  checkpoints: thread.checkpoints,
                  shellLatestTurn: Option.getOrThrow(shell).latestTurn,
                };
              }),
            );
          const before = yield* readWorkState();
          const startSequence = yield* headSequence(server);

          const callId = "voice-call-no-turn-0001";
          yield* expectStatus(voice(server).start("owner", callId), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0001", [
              fragment(1, "Arreglá el bug del login."),
              fragment(2, " Le pido al agente que lo revise."),
            ]),
            200,
          );
          yield* expectStatus(voice(server).end("owner", callId, 2), 200);

          const events = yield* readEvents(server, startSequence);
          expect(events.map((event) => event.type)).toEqual([
            "thread.voice-call-started",
            "thread.voice-transcript-appended",
            "thread.voice-call-ended",
          ]);
          expect(events.every((event) => VOICE_EVENT_TYPES.has(event.type))).toBe(true);
          const after = yield* readWorkState();
          expect(after).toEqual(before);
        }),
    );

    it.effect(
      "VH-H12 a lapsed heartbeat lease persists an expired call that the owner can still flush",
      () =>
        Effect.gen(function* () {
          const { harness, server } = yield* bootWithThread;
          const callId = "voice-call-expired-0001";
          yield* expectStatus(voice(server).start("owner", callId), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0001", [
              fragment(1, "¿Seguís ahí?"),
              fragment(2, " Sí."),
            ]),
            200,
          );

          yield* harness.advanceCallClock(61_000);
          const expired = yield* expectJson<FragmentPage>(
            voice(server).listFragments("viewer", callId),
          );
          expect(expired.call.endReason).toBe("expired");
          expect(expired.call.endedAt).not.toBeNull();
          expect(expired.call.finalSequence).toBeNull();
          yield* expectStatus(voice(server).heartbeat("owner", callId), 404);
          // The server ended the call without a transcript boundary.
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0002", [fragment(3, "Pendiente.")]),
            409,
          );

          yield* expectStatus(voice(server).end("owner", callId, 3), 200);
          const bounded = yield* expectJson<FragmentPage>(
            voice(server).listFragments("viewer", callId),
          );
          expect(bounded.call.endReason).toBe("expired");
          expect(bounded.call.endedAt).toBe(expired.call.endedAt);
          expect(bounded.call.finalSequence).toBe(3);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0002", [fragment(3, "Pendiente.")]),
            200,
          );
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0003", [fragment(4, "Más allá.")]),
            409,
          );
          yield* expectStatus(voice(server).start("owner", "voice-call-expired-0002"), 200);
        }),
    );

    it.effect("VH-H13 the 15-minute limit persists a max-duration end for a live call", () =>
      Effect.gen(function* () {
        const { harness, server } = yield* bootWithThread;
        const callId = "voice-call-max-0001";
        yield* expectStatus(voice(server).start("owner", callId), 200);
        // Heartbeats keep the 60-second lease alive until the 900-second limit.
        for (let elapsed = 50; elapsed < 900; elapsed += 50) {
          yield* harness.advanceCallClock(50_000);
          yield* expectStatus(voice(server).heartbeat("owner", callId), 200);
        }
        const open = yield* expectJson<CallPage>(voice(server).listCalls("viewer"));
        expect(open.calls[0]?.endedAt).toBeNull();

        yield* harness.advanceCallClock(50_000);
        const ended = yield* expectJson<FragmentPage>(
          voice(server).listFragments("viewer", callId),
        );
        expect(ended.call.endReason).toBe("max-duration");
        expect(ended.call.finalSequence).toBeNull();
        yield* expectStatus(voice(server).end("owner", callId, 1), 200);
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0001", [fragment(1, "Último.")]),
          200,
        );
        const flushed = yield* readAllFragments(server, "viewer", callId);
        expect(flushed.fragments).toEqual([fragment(1, "Último.")]);
        expect(flushed.call.endReason).toBe("max-duration");
      }),
    );

    it.effect("VH-H14 a checkpoint revert keeps the voice history as a conversation record", () =>
      Effect.gen(function* () {
        const { server } = yield* bootWithThread;
        const callId = "voice-call-revert-0001";
        yield* expectStatus(voice(server).start("owner", callId), 200);
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0001", [
            fragment(1, "Probá el cambio."),
            fragment(2, " Lo pruebo."),
          ]),
          200,
        );
        yield* expectStatus(voice(server).end("owner", callId, 2), 200);
        const before = yield* readAllFragments(server, "viewer", callId);

        yield* server.run(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            yield* engine.dispatch({
              type: "thread.revert.complete",
              commandId: CommandId.make("cmd-voice-history-revert"),
              threadId: THREAD_ID,
              turnCount: 0,
              createdAt: DateTime.formatIso(yield* DateTime.now),
            });
          }),
        );
        const events = yield* readEvents(server, 0);
        expect(events.at(-1)?.type).toBe("thread.reverted");
        const after = yield* readAllFragments(server, "viewer", callId);
        expect(after).toEqual(before);
      }),
    );

    it.effect(
      "VH-H15 the owner bounds and flushes an interrupted call after restarts without reopening audio",
      () =>
        Effect.gen(function* () {
          const { harness, server } = yield* bootWithThread;
          const callId = "voice-call-recover-0001";
          const acknowledged = [fragment(1, "Antes del reinicio."), fragment(2, " Recibido.")];
          const pending = [fragment(3, " Pendiente local,"), fragment(4, " sin confirmar.")];
          yield* expectStatus(voice(server).start("owner", callId), 200);
          const ack = yield* expectJson<{ lastSequence: number }>(
            voice(server).append("owner", callId, "batch-0001", acknowledged),
          );
          expect(ack.lastSequence).toBe(2);
          const providerSessionsBefore = providerSessionCount;

          const restarted = yield* harness.restart(server);
          const interrupted = yield* expectJson<FragmentPage>(
            voice(restarted).listFragments("owner", callId),
          );
          expect(interrupted.call.endReason).toBe("interrupted");
          expect(interrupted.call.finalSequence).toBeNull();
          yield* expectStatus(voice(restarted).heartbeat("owner", callId), 404);

          // One stable final boundary, then the pending flush up to it.
          yield* expectStatus(voice(restarted).end("intruder", callId, 4), 404);
          yield* expectStatus(voice(restarted).end("owner", callId, 4), 200);
          yield* expectStatus(voice(restarted).end("owner", callId, 4), 200);
          yield* expectStatus(voice(restarted).end("owner", callId, 5), 409);
          yield* expectStatus(voice(restarted).end("owner", callId, 1), 409);
          yield* expectStatus(
            voice(restarted).append("intruder", callId, "batch-0002", pending),
            404,
          );
          const flushed = yield* expectJson<{ lastSequence: number }>(
            voice(restarted).append("owner", callId, "batch-0002", pending),
          );
          expect(flushed.lastSequence).toBe(4);
          const retried = yield* expectJson<{ lastSequence: number }>(
            voice(restarted).append("owner", callId, "batch-0002", pending),
          );
          expect(retried).toEqual(flushed);
          yield* expectStatus(
            voice(restarted).append("owner", callId, "batch-0003", [fragment(5, "Fuera.")]),
            409,
          );

          const expected = {
            fragments: [...acknowledged, ...pending],
            endReason: "interrupted",
            endedAt: interrupted.call.endedAt,
            finalSequence: 4,
          };
          const readRecord = Effect.fn("readRecord")(function* (running: RunningServer) {
            const history = yield* readAllFragments(running, "viewer", callId);
            return {
              fragments: history.fragments,
              endReason: history.call.endReason,
              endedAt: history.call.endedAt,
              finalSequence: history.call.finalSequence,
            };
          });
          expect(yield* readRecord(restarted)).toEqual(expected);

          const again = yield* harness.restart(restarted);
          expect(yield* readRecord(again)).toEqual(expected);
          yield* harness.stop(again);
          expect(dropVoiceProjection(harness.databasePath)).toBe(4);
          const replayed = yield* harness.boot;
          expect(yield* readRecord(replayed)).toEqual(expected);
          yield* expectStatus(
            voice(replayed).append("owner", callId, "batch-0003", [fragment(5, "Fuera.")]),
            409,
          );
          expect(providerSessionCount).toBe(providerSessionsBefore);
        }),
    );

    it.effect(
      "VH-H16 an invalid final boundary still hangs up the owner's audio and keeps the text",
      () =>
        Effect.gen(function* () {
          const { server } = yield* bootWithThread;
          const callId = "voice-call-low-end-0001";
          const spoken = [fragment(1, "Primera parte."), fragment(2, " Segunda parte.")];
          yield* expectStatus(voice(server).start("owner", callId), 200);
          yield* expectStatus(voice(server).append("owner", callId, "batch-0001", spoken), 200);
          const hangupsBefore = providerHangupCount;
          const createsBefore = providerSessionCount;

          // A read-only viewer and a foreign operator cannot end the call or close its audio.
          yield* expectStatus(voice(server).end("viewer", callId, 1), 403);
          yield* expectStatus(voice(server).end("intruder", callId, 1), 404);
          expect(providerHangupCount).toBe(hangupsBefore);
          const untouched = yield* readAllFragments(server, "viewer", callId);
          expect(untouched.call.endedAt).toBeNull();
          yield* expectStatus(voice(server).heartbeat("owner", callId), 200);

          // The boundary is rejected, but the owner's hangup closes provider audio once.
          yield* expectStatus(voice(server).end("owner", callId, 1), 409);
          expect(providerHangupCount).toBe(hangupsBefore + 1);
          yield* expectStatus(voice(server).heartbeat("owner", callId), 404);
          const ended = yield* readAllFragments(server, "viewer", callId);
          expect(ended.fragments).toEqual(spoken);
          expect(ended.call.endedAt).not.toBeNull();
          expect(ended.call.endReason).toBe("hangup");
          expect(ended.call.finalSequence).toBeNull();

          // The microphone is free for a new call.
          const nextCallId = "voice-call-low-end-0002";
          yield* expectStatus(voice(server).start("owner", nextCallId), 200);
          expect(providerSessionCount).toBe(createsBefore + 1);

          // The old call takes one valid boundary later and flushes its pending text.
          yield* expectStatus(voice(server).end("owner", callId, 3), 200);
          yield* expectStatus(voice(server).end("owner", callId, 3), 200);
          const pending = [fragment(3, " Pendiente.")];
          yield* expectStatus(voice(server).append("owner", callId, "batch-0002", pending), 200);
          yield* expectStatus(voice(server).append("owner", callId, "batch-0002", pending), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0003", [fragment(4, "Fuera.")]),
            409,
          );
          const finalized = yield* readAllFragments(server, "viewer", callId);
          expect(finalized.fragments).toEqual([...spoken, ...pending]);
          expect(finalized.call.finalSequence).toBe(3);
          expect(finalized.call.endReason).toBe("hangup");
          expect(finalized.call.endedAt).toBe(ended.call.endedAt);

          // Finalizing the old call neither recreated nor closed the new call's audio.
          yield* expectStatus(voice(server).heartbeat("owner", nextCallId), 200);
          expect(providerHangupCount).toBe(hangupsBefore + 1);
          expect(providerSessionCount).toBe(createsBefore + 1);
          const next = yield* expectJson<FragmentPage>(
            voice(server).listFragments("viewer", nextCallId),
          );
          expect(next.call.endedAt).toBeNull();
        }),
    );

    it.effect(
      "VH-H17 a failed provider hangup does not replace the rejected boundary response",
      () =>
        Effect.gen(function* () {
          const { server } = yield* bootWithThread;
          const callId = "voice-call-low-end-0003";
          yield* expectStatus(voice(server).start("owner", callId), 200);
          yield* expectStatus(
            voice(server).append("owner", callId, "batch-0001", [
              fragment(1, "Uno."),
              fragment(2, " Dos."),
            ]),
            200,
          );

          failingProviderHangups = 1;
          const rejected = yield* expectStatus(voice(server).end("owner", callId, 1), 409);
          expect(rejected).toContain("below stored fragments");
          const ended = yield* readAllFragments(server, "viewer", callId);
          expect(ended.call.endReason).toBe("hangup");
          expect(ended.call.finalSequence).toBeNull();

          // A later valid end retries the bounded provider cleanup and records the boundary.
          const hangupsBefore = providerHangupCount;
          yield* expectStatus(voice(server).end("owner", callId, 2), 200);
          expect(providerHangupCount).toBe(hangupsBefore + 1);
          yield* expectStatus(voice(server).heartbeat("owner", callId), 404);
          const bounded = yield* readAllFragments(server, "viewer", callId);
          expect(bounded.call.finalSequence).toBe(2);
          yield* expectStatus(voice(server).start("owner", "voice-call-low-end-0004"), 200);
        }),
    );

    it.effect(
      "VH-H18 a batch ID keeps its complete accepted content across restart and replay",
      () =>
        Effect.gen(function* () {
          const { harness, server } = yield* bootWithThread;
          const callId = "voice-call-batch-identity-0001";
          const [one, two, three] = [
            fragment(1, "Uno."),
            fragment(2, " Dos."),
            fragment(3, "Tres."),
          ];
          yield* expectStatus(voice(server).start("owner", callId), 200);

          const assertBatchIdentity = Effect.fn("assertBatchIdentity")(function* (
            running: RunningServer,
          ) {
            // A subset of an accepted batch is different content, even though each fragment matches.
            yield* expectStatus(voice(running).append("owner", callId, "batch-a", [one]), 409);
            // A batch first accepted as a no-op re-send cannot later carry new fragments.
            yield* expectStatus(voice(running).append("owner", callId, "batch-b", [three]), 409);
            // A changed overlap is different content.
            yield* expectStatus(
              voice(running).append("owner", callId, "batch-c", [two, three]),
              409,
            );
            // Exact retries of all three accepted batches stay idempotent.
            for (const [batchId, fragments] of [
              ["batch-a", [one, two]],
              ["batch-b", [one, two]],
              ["batch-c", [one, three]],
            ] as const) {
              const retried = yield* expectJson<{ lastSequence: number }>(
                voice(running).append("owner", callId, batchId, fragments),
              );
              expect(retried.lastSequence).toBe(3);
            }
            const history = yield* readAllFragments(running, "viewer", callId);
            expect(history.fragments).toEqual([one, two, three]);
          });

          yield* expectStatus(voice(server).append("owner", callId, "batch-a", [one, two]), 200);
          // The same fragments under a new batch ID are accepted without storing them twice.
          yield* expectStatus(voice(server).append("owner", callId, "batch-b", [one, two]), 200);
          yield* expectStatus(voice(server).append("owner", callId, "batch-c", [one, three]), 200);
          yield* assertBatchIdentity(server);

          const restarted = yield* harness.restart(server);
          yield* assertBatchIdentity(restarted);

          yield* harness.stop(restarted);
          expect(dropVoiceProjection(harness.databasePath)).toBe(3);
          const replayed = yield* harness.boot;
          yield* assertBatchIdentity(replayed);
        }),
    );

    // The automatic end of a live call survives a transient storage failure: audio closes at
    // once, and the persisted end is retried by the next completed sweep with its first reason
    // and time.
    const runAutomaticEndRecovery = Effect.fn("runAutomaticEndRecovery")(function* (
      reason: "expired" | "max-duration",
    ) {
      const { harness, server } = yield* bootWithThread;
      const callId = `voice-call-auto-end-${reason}`;
      const spoken = [fragment(1, "Antes del corte."), fragment(2, " Sigue.")];
      yield* expectStatus(voice(server).start("owner", callId), 200);
      yield* expectStatus(voice(server).append("owner", callId, "batch-0001", spoken), 200);
      if (reason === "max-duration") {
        for (let elapsed = 50; elapsed < 900; elapsed += 50) {
          yield* harness.advanceCallClock(50_000);
          yield* expectStatus(voice(server).heartbeat("owner", callId), 200);
        }
      }
      const hangupsBefore = providerHangupCount;

      setVoiceEndWriteFailure(harness.databasePath, true);
      const failedAt = DateTime.formatIso(yield* DateTime.now);
      yield* harness.advanceCallClock(reason === "max-duration" ? 50_000 : 61_000);
      const sweptAt = DateTime.formatIso(yield* DateTime.now);
      // Provider audio closed and the microphone is free, although the history write failed.
      expect(providerHangupCount).toBe(hangupsBefore + 1);
      yield* expectStatus(voice(server).heartbeat("owner", callId), 404);
      const nextCallId = `voice-call-auto-next-${reason}`;
      yield* expectStatus(voice(server).start("owner", nextCallId), 200);
      // The pending end still governs the old call: no append is accepted as if it were open.
      yield* expectStatus(
        voice(server).append("owner", callId, "batch-0002", [fragment(3, "Pendiente.")]),
        502,
      );

      setVoiceEndWriteFailure(harness.databasePath, false);
      yield* harness.advanceCallClock(15_000);
      const ended = yield* readAllFragments(server, "viewer", callId);
      expect(ended.fragments).toEqual(spoken);
      expect(ended.call.endReason).toBe(reason);
      expect(ended.call.finalSequence).toBeNull();
      // The retried end keeps the time of the first attempt, not the time of the retry.
      expect(ended.call.endedAt).not.toBeNull();
      expect(ended.call.endedAt! >= failedAt && ended.call.endedAt! <= sweptAt).toBe(true);
      yield* expectStatus(
        voice(server).append("owner", callId, "batch-0002", [fragment(3, "Pendiente.")]),
        409,
      );
      yield* expectStatus(voice(server).end("owner", callId, 3), 200);
      yield* expectStatus(
        voice(server).append("owner", callId, "batch-0002", [fragment(3, "Pendiente.")]),
        200,
      );
      // The new call kept its audio through the old call's recovery.
      yield* expectStatus(voice(server).heartbeat("owner", nextCallId), 200);
      expect(providerHangupCount).toBe(hangupsBefore + 1);
    });

    it.effect("VH-H19 an expired call records its end after a transient storage failure", () =>
      runAutomaticEndRecovery("expired"),
    );

    it.effect("VH-H20 a max-duration call records its end after a transient storage failure", () =>
      runAutomaticEndRecovery("max-duration"),
    );

    it.effect(
      "VH-H21 an upgrade to migration 54 keeps the identity of batches accepted under 53",
      () =>
        Effect.gen(function* () {
          const { harness, server } = yield* bootWithThread;
          const callId = "voice-call-upgrade-0001";
          const accepted = [fragment(1, "Antes de la migración."), fragment(2, " Aceptado.")];
          yield* expectStatus(voice(server).start("owner", callId), 200);
          // A batch of only new fragments: its event is the same under 53 and 54, so its complete
          // request can be rebuilt from the event store.
          yield* expectStatus(voice(server).append("owner", callId, "batch-a", accepted), 200);
          yield* harness.stop(server);

          // Return the file to its state before 54 existed: 053 applied, the append event and its
          // accepted receipt stored, the voice rows projected and the voice cursor at the end.
          rollBackToMigration53(harness.databasePath);
          const upgraded = yield* harness.boot;

          const assertUpgradedIdentity = Effect.fn("assertUpgradedIdentity")(function* (
            running: RunningServer,
          ) {
            const retried = yield* expectJson<{ lastSequence: number }>(
              voice(running).append("owner", callId, "batch-a", accepted),
            );
            expect(retried.lastSequence).toBe(2);
            yield* expectStatus(
              voice(running).append("owner", callId, "batch-a", [accepted[0]!]),
              409,
            );
            const history = yield* readAllFragments(running, "viewer", callId);
            expect(history.fragments).toEqual(accepted);
          });
          yield* assertUpgradedIdentity(upgraded);

          const restarted = yield* harness.restart(upgraded);
          yield* assertUpgradedIdentity(restarted);
          yield* harness.stop(restarted);
          expect(dropVoiceProjection(harness.databasePath)).toBe(2);
          const replayed = yield* harness.boot;
          yield* assertUpgradedIdentity(replayed);
        }),
    );

    it.effect("VH-H22 an offset-only change to a stored fragment is different content", () =>
      Effect.gen(function* () {
        const { server } = yield* bootWithThread;
        const callId = "voice-call-offsets-0001";
        const stored = fragment(1, "Mismo texto.");
        yield* expectStatus(voice(server).start("owner", callId), 200);
        yield* expectStatus(voice(server).append("owner", callId, "batch-0001", [stored]), 200);
        const shifted = { ...stored, endOffsetMs: stored.endOffsetMs! + 1 };
        const { startOffsetMs: _droppedStart, ...withoutStart } = stored;
        // Under the accepted batch ID, and under a new one.
        yield* expectStatus(voice(server).append("owner", callId, "batch-0001", [shifted]), 409);
        yield* expectStatus(voice(server).append("owner", callId, "batch-0002", [shifted]), 409);
        yield* expectStatus(
          voice(server).append("owner", callId, "batch-0003", [withoutStart]),
          409,
        );
        const history = yield* readAllFragments(server, "viewer", callId);
        expect(history.fragments).toEqual([stored]);
      }),
    );
  },
);
