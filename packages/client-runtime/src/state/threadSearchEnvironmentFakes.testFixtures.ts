/**
 * Disposable environment fakes for thread search tests. Each fake environment
 * answers the real orchestration RPC tags through a fake `RpcSession`, and the
 * fake `EnvironmentRegistry` routes `registry.run` to that environment's
 * supervisor. Code under test therefore reaches the fakes through the same
 * `request(tag, input)` path it uses against a real server.
 *
 * The evidence fake mirrors the server contract from phase 1: newest message
 * first, a fixed scan window per request, case-insensitive contiguous match,
 * pages that can be empty while `nextCursor` is set, and cursors bound to one
 * query and thread scope.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationSearchThreadsError,
  ProjectId,
  THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH,
  ThreadId,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchCatalogInput,
  type OrchestrationThreadSearchCatalogPage,
  type OrchestrationThreadSearchEvidence,
  type OrchestrationThreadSearchEvidenceInput,
  type OrchestrationThreadSearchEvidencePage,
  type OrchestrationThreadSearchReasoningInput,
  type OrchestrationThreadSearchSource,
  type OrchestrationThreadSearchStep,
  type ServerConfig,
  type TextGenerationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentNotRegisteredError, EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

/** The server's per-request scan window (THREAD_SEARCH_EVIDENCE_SCAN_BUDGET). */
export const FAKE_EVIDENCE_SCAN_WINDOW = 2_000;
const FAKE_EVIDENCE_DEFAULT_PAGE_SIZE = 20;
const FAKE_CATALOG_DEFAULT_PAGE_SIZE = 100;
const FAKE_EXCERPT_LEAD = 60;

export interface FakeMessage {
  readonly messageId: string;
  readonly source: OrchestrationThreadSearchSource;
  readonly text: string;
  readonly createdAt: string;
}

export interface FakeThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  /** Oldest first, as the conversation happened. */
  readonly messages: ReadonlyArray<FakeMessage>;
}

export type FakeReason = (
  input: OrchestrationThreadSearchReasoningInput,
) => Effect.Effect<OrchestrationThreadSearchStep, TextGenerationError>;

export interface FakeEnvironmentSpec {
  readonly environmentId: string;
  readonly label: string;
  readonly threads: ReadonlyArray<FakeThread>;
  /** False starts the environment with no session, as a disconnected one. */
  readonly connected?: boolean;
  /** Drops the session right after the first catalog page is served. */
  readonly disconnectAfterCatalog?: boolean;
  /** Present only on the environment that runs the configured model. */
  readonly reason?: FakeReason;
  /** Replaces one RPC handler, for failures and hangs. */
  readonly override?: {
    readonly listThreadSearchCatalog?: (
      input: OrchestrationThreadSearchCatalogInput,
    ) => Effect.Effect<OrchestrationThreadSearchCatalogPage, OrchestrationSearchThreadsError>;
    readonly searchThreadEvidence?: (
      input: OrchestrationThreadSearchEvidenceInput,
    ) => Effect.Effect<OrchestrationThreadSearchEvidencePage, OrchestrationSearchThreadsError>;
  };
}

export interface RecordedRpcCall {
  readonly environmentId: string;
  readonly method: string;
  readonly input: unknown;
}

export function isoAt(minutes: number): string {
  return DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"), { minutes }),
  );
}

export function makeFakeThread(
  options: Omit<FakeThread, "updatedAt" | "messages" | "archivedAt"> & {
    readonly archivedAt?: string | null;
    readonly texts: ReadonlyArray<string>;
    /** Minute offset of the first message; later messages follow a minute apart. */
    readonly startMinute?: number;
  },
): FakeThread {
  const startMinute = options.startMinute ?? 0;
  const messages = options.texts.map((text, index): FakeMessage => ({
    messageId: `${options.threadId}-message-${index}`,
    source: index % 2 === 0 ? "user" : "assistant",
    text,
    createdAt: isoAt(startMinute + index),
  }));
  return {
    threadId: options.threadId,
    projectId: options.projectId,
    title: options.title,
    projectTitle: options.projectTitle,
    archivedAt: options.archivedAt ?? null,
    updatedAt: messages.at(-1)?.createdAt ?? isoAt(startMinute),
    messages,
  };
}

function searchFailure(message: string) {
  return new OrchestrationSearchThreadsError({ message });
}

function excerptAround(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - FAKE_EXCERPT_LEAD);
  return text.slice(start, start + THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH);
}

interface FakeEvidenceCursor {
  readonly query: string;
  readonly threadId: string | null;
  readonly position: number;
}

function serveCatalog(
  threads: ReadonlyArray<FakeThread>,
  input: OrchestrationThreadSearchCatalogInput,
): Effect.Effect<OrchestrationThreadSearchCatalogPage, OrchestrationSearchThreadsError> {
  const offset = input.cursor === undefined ? 0 : Number(JSON.parse(input.cursor));
  if (!Number.isInteger(offset) || offset < 0) {
    return Effect.fail(searchFailure("Invalid catalog cursor."));
  }
  const limit = input.limit ?? FAKE_CATALOG_DEFAULT_PAGE_SIZE;
  const page = threads.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return Effect.succeed({
    threads: page.map((thread) => ({
      threadId: ThreadId.make(thread.threadId),
      projectId: ProjectId.make(thread.projectId),
      title: thread.title,
      projectTitle: thread.projectTitle,
      archivedAt: thread.archivedAt,
      updatedAt: thread.updatedAt,
    })),
    nextCursor: nextOffset < threads.length ? JSON.stringify(nextOffset) : null,
  });
}

function serveEvidence(
  threads: ReadonlyArray<FakeThread>,
  input: OrchestrationThreadSearchEvidenceInput,
): Effect.Effect<OrchestrationThreadSearchEvidencePage, OrchestrationSearchThreadsError> {
  const threadScope = input.threadId ?? null;
  let position = 0;
  if (input.cursor !== undefined) {
    const cursor = JSON.parse(input.cursor) as FakeEvidenceCursor;
    // Phase 1 binds a cursor to its search: reusing it for another query or
    // thread scope is rejected rather than silently resumed.
    if (cursor.query !== input.query || cursor.threadId !== threadScope) {
      return Effect.fail(searchFailure("Cursor does not belong to this search."));
    }
    position = cursor.position;
  }

  const scanned = threads
    .filter((thread) => threadScope === null || thread.threadId === threadScope)
    .flatMap((thread) => thread.messages.map((message) => ({ thread, message })))
    .sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt));
  const limit = input.limit ?? FAKE_EVIDENCE_DEFAULT_PAGE_SIZE;
  const windowEnd = Math.min(scanned.length, position + FAKE_EVIDENCE_SCAN_WINDOW);
  const needle = input.query.toLowerCase();
  const matches: OrchestrationThreadSearchEvidence[] = [];
  let cursorPosition = position;
  while (cursorPosition < windowEnd && matches.length < limit) {
    const { thread, message } = scanned[cursorPosition]!;
    cursorPosition += 1;
    if (!message.text.toLowerCase().includes(needle)) continue;
    matches.push({
      messageId: MessageId.make(message.messageId),
      threadId: ThreadId.make(thread.threadId),
      projectId: ProjectId.make(thread.projectId),
      title: thread.title,
      projectTitle: thread.projectTitle,
      archivedAt: thread.archivedAt,
      source: message.source,
      messageCreatedAt: message.createdAt,
      excerpt: excerptAround(message.text, input.query),
    });
  }
  const nextCursor: FakeEvidenceCursor = {
    query: input.query,
    threadId: threadScope,
    position: cursorPosition,
  };
  return Effect.succeed({
    matches,
    nextCursor: cursorPosition < scanned.length ? JSON.stringify(nextCursor) : null,
  });
}

/** Lexical search as the active-only picker sees it, for guards on searchThreads. */
function serveLexicalSearch(
  threads: ReadonlyArray<FakeThread>,
  input: OrchestrationSearchThreadsInput,
): Effect.Effect<OrchestrationSearchThreadsResult> {
  const needle = input.query.toLowerCase();
  return Effect.succeed({
    matches: threads
      .filter((thread) => thread.archivedAt === null)
      .flatMap((thread) =>
        thread.messages
          .filter((message) => message.text.toLowerCase().includes(needle))
          .map((message) => ({
            threadId: ThreadId.make(thread.threadId),
            projectId: ProjectId.make(thread.projectId),
            source: message.source,
            snippet: excerptAround(message.text, input.query),
            messageCreatedAt: message.createdAt,
          })),
      ),
  });
}

const CONFIG = {
  settings: DEFAULT_SERVER_SETTINGS,
  environment: { serverVersion: "0.0.1", capabilities: {} },
} as ServerConfig;

export const makeFakeEnvironments = Effect.fn("ThreadSearchFakes.makeFakeEnvironments")(function* (
  specs: ReadonlyArray<FakeEnvironmentSpec>,
) {
  const calls: RecordedRpcCall[] = [];
  // Catalog and evidence reads in flight across every environment. Each read
  // yields before it answers, so reads the caller runs concurrently overlap.
  let readsInFlight = 0;
  let maxReadsInFlight = 0;
  const measureRead = <A, E>(read: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        readsInFlight += 1;
        maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight);
      }),
      () => Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(read)),
      () =>
        Effect.sync(() => {
          readsInFlight -= 1;
        }),
    );
  const supervisors = new Map<string, EnvironmentSupervisor["Service"]>();

  for (const spec of specs) {
    const record = (method: string, input: unknown) =>
      Effect.sync(() => {
        calls.push({ environmentId: spec.environmentId, method, input });
      });
    const sessionRef = yield* SubscriptionRef.make(Option.none<RpcSession>());
    const client = {
      [ORCHESTRATION_WS_METHODS.searchThreads]: (input: OrchestrationSearchThreadsInput) =>
        record(ORCHESTRATION_WS_METHODS.searchThreads, input).pipe(
          Effect.andThen(serveLexicalSearch(spec.threads, input)),
        ),
      [ORCHESTRATION_WS_METHODS.listThreadSearchCatalog]: (
        input: OrchestrationThreadSearchCatalogInput,
      ) =>
        record(ORCHESTRATION_WS_METHODS.listThreadSearchCatalog, input).pipe(
          Effect.andThen(
            measureRead(
              spec.override?.listThreadSearchCatalog?.(input) ?? serveCatalog(spec.threads, input),
            ),
          ),
          Effect.tap(() =>
            spec.disconnectAfterCatalog
              ? SubscriptionRef.set(sessionRef, Option.none())
              : Effect.void,
          ),
        ),
      [ORCHESTRATION_WS_METHODS.searchThreadEvidence]: (
        input: OrchestrationThreadSearchEvidenceInput,
      ) =>
        record(ORCHESTRATION_WS_METHODS.searchThreadEvidence, input).pipe(
          Effect.andThen(
            measureRead(
              spec.override?.searchThreadEvidence?.(input) ?? serveEvidence(spec.threads, input),
            ),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.reasonThreadSearch]: (
        input: OrchestrationThreadSearchReasoningInput,
      ) =>
        record(ORCHESTRATION_WS_METHODS.reasonThreadSearch, input).pipe(
          Effect.andThen(
            spec.reason?.(input) ??
              Effect.die(new Error(`${spec.environmentId} does not run the configured model.`)),
          ),
        ),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.succeed(CONFIG),
      subscribeServerConfig: () => Stream.empty,
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const connected = spec.connected ?? true;
    if (connected) {
      yield* SubscriptionRef.set(sessionRef, Option.some(session));
    }
    supervisors.set(
      spec.environmentId,
      EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make(spec.environmentId),
          label: spec.label,
          httpBaseUrl: `https://${spec.environmentId}.example.test`,
          wsBaseUrl: `wss://${spec.environmentId}.example.test`,
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: connected ? "connected" : "offline",
        }),
        session: sessionRef,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }

  const registry = EnvironmentRegistry.of({
    run: (environmentId, effect) => {
      const supervisor = supervisors.get(environmentId);
      return supervisor === undefined
        ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId }))
        : Effect.provideService(effect, EnvironmentSupervisor, supervisor);
    },
    followStream: (environmentId, stream) => {
      const supervisor = supervisors.get(environmentId);
      return supervisor === undefined
        ? Stream.die(new Error(`Environment ${environmentId} is not registered.`))
        : Stream.provideService(stream, EnvironmentSupervisor, supervisor);
    },
  } as EnvironmentRegistry["Service"]);

  return {
    registry,
    calls,
    maxReadsInFlight: () => maxReadsInFlight,
    callsTo: (environmentId: string, method: string) =>
      calls.filter((call) => call.environmentId === environmentId && call.method === method),
  };
});
